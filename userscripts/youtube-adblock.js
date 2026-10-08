// ==UserScript==
// @name         YouTube Ad-Free
// @description  Remove YouTube ads, especially pre-roll/mid-roll video ads: strip ad data out of the player response before YouTube's player reads it, drop ad/analytics requests, then skip or force-end any ad that still slips through.
// @version      3.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Strip the ad payload out of player / next responses
  //    This is what actually kills pre-roll ads: if adPlacements/playerAds are
  //    gone before the player builds its ad schedule, no ad is ever requested.
  // ═══════════════════════════════════════════════════════════════════════════
  var AD_FIELDS = [
    'adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams',
    'playerLegacyDesktopWatchAdsRenderer', 'adBreakParams', 'adParams',
    'clientSideAdBreakParams', 'adBreakServiceRenderer', 'playerAdParams', 'adThrottled',
    'adSignalsInfo', 'adBreakHeartbeatParams2', 'playerAdParamsRenderer',
  ];

  // Strip the ad parameters from an OUTGOING player/next request body. YouTube
  // builds the ad schedule from these, so removing them means the response comes
  // back with no pre-roll or mid-roll ad to play at all — the difference between
  // "skip the ad quickly" and "the ad never exists".
  function stripRequestAds(text) {
    if (typeof text !== 'string' || text.length < 2) return null;
    var head = text.trim().charAt(0);
    if (head !== '{' && head !== '[') return null;
    try {
      return JSON.stringify(stripAds(JSON.parse(text)));
    } catch (e) {
      return null;
    }
  }

  // Strip every ad field out of a player / next / ytInitialData payload, at any
  // depth. YouTube nests them (playerResponse, streamingData, overlay renderers,
  // feed payloads) and no playback path needs any of them, so a bounded deep sweep
  // beats enumerating the places they hide.
  function stripAds(obj) {
    try {
      walkAds(obj, 0);
    } catch (e) {}
    return obj;
  }

  function walkAds(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    var i, k;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) walkAds(node[i], depth + 1);
      return;
    }
    for (i = 0; i < AD_FIELDS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(node, AD_FIELDS[i])) {
        try { delete node[AD_FIELDS[i]]; } catch (e) { node[AD_FIELDS[i]] = undefined; }
      }
    }
    for (k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) walkAds(node[k], depth + 1);
    }
  }

  function patchJson(textOrObj) {
    try {
      var obj = typeof textOrObj === 'string' ? JSON.parse(textOrObj) : textOrObj;
      stripAds(obj);
      return typeof textOrObj === 'string' ? JSON.stringify(obj) : obj;
    } catch (e) { return textOrObj; }
  }

  // Player / watch-next endpoints that carry the ad schedule.
  var PLAYER_RE = /\/youtubei\/v1\/(player|next|reel\/reel_watch_sequence|guide)|get_video_info/;

  // ── 1a. window.ytInitialPlayerResponse / ytInitialData setter ──────────────
  // Runs at document-start, before YouTube's inline `var ytInitialPlayerResponse
  // = {…}` executes, so the assignment goes through our setter and comes back
  // stripped.
  try {
    var _saved = {};
    ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function (name) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get: function () { return _saved[name]; },
          set: function (v) { _saved[name] = stripAds(v); },
        });
      } catch (e) {}
    });
  } catch (e) {}

  // ── 1b. fetch() interception ───────────────────────────────────────────────
  try {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isAdUrl(url)) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (PLAYER_RE.test(url) && init && typeof init.body === 'string') {
        var reqClean = stripRequestAds(init.body);
        if (reqClean !== null) init = Object.assign({}, init, { body: reqClean });
      }
      var p = _fetch.call(this, input, init);
      if (PLAYER_RE.test(url)) {
        return p.then(function (resp) {
          try {
            return resp.clone().text().then(function (txt) {
              var mod = patchJson(txt);
              if (mod === txt) return resp;
              return new Response(mod, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            }).catch(function () { return resp; });
          } catch (e) { return resp; }
        });
      }
      return p;
    };
  } catch (e) {}

  // ── 1c. XMLHttpRequest interception ────────────────────────────────────────
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__yt_url = url;
        if (typeof url === 'string' && isAdUrl(url)) arguments[1] = 'about:blank';
      } catch (e) {}
      return _open.apply(this, arguments);
    };

    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try {
        var self = this;
        if (self.__yt_url && PLAYER_RE.test(self.__yt_url)) {
          if (typeof body === 'string') {
            var bodyClean = stripRequestAds(body);
            if (bodyClean !== null) { arguments[0] = bodyClean; }
          }
          // Patch at readystatechange(4): that fires BEFORE load/onload, so the
          // site's own onload handler already sees the stripped body.
          var done = false;
          self.addEventListener('readystatechange', function () {
            if (done || self.readyState !== 4) return;
            done = true;
            try {
              if (self.responseType === 'json') {
                stripAds(self.response);                       // mutate in place
              } else if (self.responseType === '' || self.responseType === 'text') {
                var patched = patchJson(self.responseText);
                if (patched !== self.responseText) {
                  Object.defineProperty(self, 'responseText', { configurable: true, get: function () { return patched; } });
                  Object.defineProperty(self, 'response', { configurable: true, get: function () { return patched; } });
                }
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return _send.apply(this, arguments);
    };
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Drop ad / analytics requests outright
  // ═══════════════════════════════════════════════════════════════════════════
  var AD_URLS = [
    /doubleclick\.net/,
    /googleadservices\.com/,
    /googlesyndication\.com/,
    /\/pagead\//,
    /\/ptracking/,
    /\/api\/stats\/ads/,
    /\/get_midroll_info/,
    /\/pcs\/activeview/,
    /adformat=/,
    /[?&]oad=/,
    /ads\.youtube\.com/,
    /2mdn\.net/,
    /googletagservices\.com/,
    /googletagmanager\.com/,
    /\/youtubei\/v1\/player\/ad_break/,
    /\/youtubei\/v1\/log_event/,
  ];
  function isAdUrl(u) { return typeof u === 'string' && AD_URLS.some(function (r) { return r.test(u); }); }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Fallback: skip / force-end any ad that still plays
  // ═══════════════════════════════════════════════════════════════════════════
  var AD_DOM = [
    'ytd-ad-slot-renderer', 'ytd-banner-promo-renderer', 'ytd-video-masthead-ad-v3-renderer',
    'ytd-in-feed-ad-layout-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-video-renderer',
    'ytd-display-ad-renderer', 'ytd-search-pyv-renderer', 'ytd-statement-banner-renderer',
    'ytd-brand-video-shelf-renderer', 'ytd-brand-video-singleton-renderer', 'ytd-compact-promoted-video-renderer',
    '#masthead-ad', '#player-ads', '#panels-full-bleed-ad-container',
    '.ytp-ad-overlay-container', '.ytp-ad-overlay-slot', '.ytp-ad-text-overlay', '.ytp-ad-image-overlay',
    '.ytp-ad-message-container', '.ytp-ad-progress-list', '.ytp-ad-player-overlay',
    '#ad-container', '.ytd-companion-slot-renderer',
    'ytd-enforcement-message-view-model',          // the "ad blocker detected" wall
    'tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)',
  ].join(',');

  function removeAdElements() {
    try {
      var els = document.querySelectorAll(AD_DOM);
      for (var i = 0; i < els.length; i++) { try { els[i].remove(); } catch (e) {} }
    } catch (e) {}
  }

  function adShowing(player) {
    try {
      if (player && player.classList && player.classList.contains('ad-showing')) return true;
      if (player && typeof player.getAdState === 'function' && player.getAdState() > 0) return true;
      return !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-player-overlay-layout');
    } catch (e) { return false; }
  }

  function clickSkip() {
    try {
      var btn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, ' +
        'button.ytp-ad-skip-button-container, .ytp-ad-skip-button-container button, ' +
        '[id^="skip-button"] button, button[class*="ytp-ad-skip"]'
      );
      if (btn) { btn.click(); return true; }
    } catch (e) {}
    return false;
  }

  var adWasOn = false;
  var savedRate = null;      // the viewer's own speed, put back after the ad

  function forceEnd(video) {
    try {
      if (!video) return;
      if (savedRate === null) savedRate = video.playbackRate;
      var d = video.duration;
      if (isFinite(d) && d > 0 && video.currentTime < d) video.currentTime = d;
      if (video.playbackRate < 16) video.playbackRate = 16;   // blast through if seek is ignored
    } catch (e) {}
  }

  function restore(video) {
    // Restore whatever speed the viewer had — not a hard-coded 1×, which used to
    // silently drop someone watching at 1.5×/2× back to normal after every ad.
    try { if (video && savedRate !== null) video.playbackRate = savedRate; } catch (e) {}
    savedRate = null;
  }

  function tick() {
    try {
      var player = document.querySelector('#movie_player, .html5-video-player');
      var video = document.querySelector('video.html5-main-video, video');
      if (adShowing(player)) {
        adWasOn = true;
        clickSkip();                             // click it if this ad is skippable
        forceEnd(video);                         // finish the tail either way
        removeAdElements();
      } else if (adWasOn) {
        adWasOn = false;
        restore(video);
      }
      sbEnsurePolling();                 // arm the SponsorBlock watcher for this video
    } catch (e) {}
  }

  // Fast poll only while an ad is on screen; cheap idle check otherwise.
  var fastTimer = null;
  function ensurePolling() {
    if (fastTimer) return;
    fastTimer = setInterval(function () {
      tick();
      if (!adShowing(document.querySelector('#movie_player, .html5-video-player'))) {
        clearInterval(fastTimer);
        fastTimer = null;
        restore(document.querySelector('video'));
      }
    }, 100);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3b. SponsorBlock — skip sponsor / self-promo / intro / outro segments
  // ═══════════════════════════════════════════════════════════════════════════
  // Segment data comes from the public SponsorBlock API for whichever video is
  // playing, and is skipped locally by seeking past it — the same trick as the ad
  // skip above, but data-driven. `filler` is deliberately not skipped (it removes
  // tangents a lot of people want) and `poi` marks highlights, not skip-bait.
  var SB_API = 'https://sponsor.ajay.app/api/skipSegments';
  var SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro',
                       'preview', 'music_offtopic'];
  var SB = { enabled: true, segments: [], fetchedFor: null, toast: null, muted: false };

  function sbVideoId() {
    try {
      var m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(location.search);
      if (m) return m[1];
      m = /\/shorts\/([A-Za-z0-9_-]{6,})/.exec(location.pathname);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  // The segment covering `t`, or null. The 0.15 s guard stops a skip from
  // re-triggering on the very end of the segment it just jumped over.
  function sbSegmentAt(t) {
    for (var i = 0; i < SB.segments.length; i++) {
      var s = SB.segments[i];
      if (t >= s.start && t < s.end - 0.15) return s;
    }
    return null;
  }

  function sbToast(msg) {
    try {
      if (SB.toast) { try { SB.toast.remove(); } catch (e) {} }
      var el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483647;background:rgba(0,0,0,.82);color:#fff;font:13px/1.4 sans-serif;' +
        'padding:6px 12px;border-radius:6px;pointer-events:none';
      document.documentElement.appendChild(el);
      SB.toast = el;
      setTimeout(function () {
        try { el.remove(); } catch (e) {}
        if (SB.toast === el) SB.toast = null;
      }, 3000);
    } catch (e) {}
  }

  function sbFetch(id) {
    if (!id || SB.fetchedFor === id) return;
    SB.fetchedFor = id;
    SB.segments = [];
    try {
      var url = SB_API + '?videoID=' + encodeURIComponent(id) +
                '&categories=' + encodeURIComponent(JSON.stringify(SB_CATEGORIES));
      fetch(url).then(function (r) { return r.ok ? r.json() : []; }).then(function (data) {
        if (SB.fetchedFor !== id || !Array.isArray(data)) return;
        SB.segments = data.map(function (d) {
          return { start: d.segment[0], end: d.segment[1],
                   category: d.category || 'sponsor', action: d.actionType || 'skip' };
        }).sort(function (a, b) { return a.start - b.start; });
        if (SB.segments.length) sbToast('SponsorBlock: ' + SB.segments.length + ' segment(s) available');
      }).catch(function () {});
    } catch (e) {}
  }

  // Skip (or mute) right now if playback is inside a segment.
  function sbApply(video) {
    if (!SB.enabled || !video) return;
    var seg = sbSegmentAt(video.currentTime);
    if (!seg) {
      if (SB.muted) { try { video.muted = false; } catch (e) {} SB.muted = false; }
      return;
    }
    if (seg.action === 'mute') {
      try { video.muted = true; SB.muted = true; } catch (e) {}
      sbToast('SponsorBlock: muted ' + seg.category);
      return;
    }
    if (seg.action === 'full') {
      // The whole video is the sponsor. Say so, but never navigate the tab away.
      if (!SB.fullWarnedFor) { SB.fullWarnedFor = true; sbToast('SponsorBlock: entire video is ' + seg.category); }
      return;
    }
    try {
      video.currentTime = seg.end;
      sbToast('SponsorBlock: skipped ' + seg.category + ' (' + Math.round(seg.end - seg.start) + 's)');
    } catch (e) {}
  }

  var sbTimer = null;
  function sbEnsurePolling() {
    if (sbTimer) return;
    sbTimer = setInterval(function () {
      try {
        sbFetch(sbVideoId());
        var v = document.querySelector('video.html5-main-video, video');
        var player = document.querySelector('#movie_player, .html5-video-player');
        if (v && !adShowing(player)) sbApply(v);
      } catch (e) {}
    }, 300);
  }

  // Handy for keybindings / debugging: window.omarchySponsor.toggle() etc.
  window.omarchySponsor = {
    enabled: function () { return SB.enabled; },
    toggle: function () {
      SB.enabled = !SB.enabled;
      if (SB.enabled) sbEnsurePolling(); else if (SB.muted) SB.muted = false;
      sbToast('SponsorBlock ' + (SB.enabled ? 'on' : 'off'));
      return SB.enabled;
    },
    segments: function () { return SB.segments; },
    current: function () {
      var v = document.querySelector('video.html5-main-video, video');
      return v ? sbSegmentAt(v.currentTime) : null;
    },
    refresh: function () { SB.fetchedFor = null; sbFetch(sbVideoId()); },
    categories: SB_CATEGORIES
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MutationObserver + SPA navigation
  // ═══════════════════════════════════════════════════════════════════════════
  function onMutation() {
    removeAdElements();
    if (adShowing(document.querySelector('#movie_player, .html5-video-player'))) ensurePolling();
  }

  try {
    new MutationObserver(onMutation).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  ['yt-navigate-finish', 'yt-page-data-updated'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      removeAdElements();
      tick();
      if (adShowing(document.querySelector('#movie_player, .html5-video-player'))) ensurePolling();
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    removeAdElements();
    tick();
    ensurePolling();
  });

  if (document.readyState !== 'loading') {
    removeAdElements();
    ensurePolling();
  }

  // A pre-roll can start before any mutation we notice, so poll eagerly for the
  // first 90 s after load (cheap: tick() no-ops when no ad is showing) instead of
  // relying on a DOM change to arm the fast timer.
  try {
    var eagerUntil = Date.now() + 90000;
    var eager = setInterval(function () {
      tick();
      if (Date.now() > eagerUntil) { clearInterval(eager); eager = null; }
    }, 250);
  } catch (e) {}
})();

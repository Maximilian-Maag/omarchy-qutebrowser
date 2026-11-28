// ==UserScript==
// @name         YouTube Ad-Free
// @description  Remove YouTube ads: strip the ad fields from the player request and prune them from the response (uBO's json-prune-fetch-response, minus the stale Content-Length), compress the 17 s ad countdown, re-load a video that came back ad-blocked or wedged, then skip or force-end any ad that still slips through.
// @version      3.2
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

  // Strip the ad fields out of an OUTGOING player/next request body.
  // Kept after an A/B on a live watch page (Nov 2026): without it the server
  // schedules a mid-roll and the player briefly detaches the stream at each break
  // — duration NaN, state -1 — even when the response is pruned; with it the break
  // is never scheduled and playback is continuous. Separately: a pruned fetch
  // response that keeps its old Content-Length is what actually kills a player, so
  // pruneFetchResponse drops that header. Do not remove one without testing the
  // other on a monetised video.
  function stripRequestAds(text) {
    if (typeof text !== 'string' || text.length < 2) return null;
    // Anything that is not a JSON object is not a request body. A JSON number
    // parses fine, which is why the head check comes before JSON.parse.
    if (text.trim().charAt(0) !== '{') return null;
    var body;
    try { body = JSON.parse(text); } catch (e) { return null; }
    if (!stripAds(body)) return null;          // unchanged: keep the original bytes
    try { return JSON.stringify(body); } catch (e) { return null; }
  }

  // Strip every ad field out of a player / next / ytInitialData payload, at any
  // depth. YouTube nests them (playerResponse, streamingData, overlay renderers,
  // feed payloads) and no playback path needs any of them, so a bounded deep sweep
  // beats enumerating the places they hide. Returns how many fields were removed,
  // so a response that carries no ads is handed back untouched (uBO's
  // json-prune-fetch-response does the same — never reserialise for nothing).
  function stripAds(obj) {
    try {
      return walkAds(obj, 0);
    } catch (e) {
      return 1;
    }
  }

  function walkAds(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return 0;
    var i, k, hits = 0;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) hits += walkAds(node[i], depth + 1);
      return hits;
    }
    for (i = 0; i < AD_FIELDS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(node, AD_FIELDS[i])) {
        try { delete node[AD_FIELDS[i]]; } catch (e) { node[AD_FIELDS[i]] = undefined; }
        hits++;
      }
    }
    for (k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) hits += walkAds(node[k], depth + 1);
    }
    return hits;
  }

  function patchJson(textOrObj) {
    try {
      var obj = typeof textOrObj === 'string' ? JSON.parse(textOrObj) : textOrObj;
      stripAds(obj);
      return typeof textOrObj === 'string' ? JSON.stringify(obj) : obj;
    } catch (e) { return textOrObj; }
  }

  // uBO's json-prune-fetch-response: prune the object the page will read and hand
  // back a Response built from it, keeping status/statusText/headers. Reading
  // `.json()` (not `.text()` + reserialise) is what keeps the content-type and the
  // bytes the page's own parser sees in step.
  function pruneFetchResponse(resp) {
    try {
      return resp.clone().json().then(function (obj) {
        if (!obj || typeof obj !== 'object') return resp;
        if (!stripAds(obj)) return resp;
        // The body got shorter, so the original Content-Length is now a lie and
        // Chromium refuses/truncates the read. uBO drops both of these too — a
        // kept Content-Length is exactly how a pruned response kills the player.
        var headers = new Headers(resp.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(JSON.stringify(obj), {
          status: resp.status, statusText: resp.statusText, headers: headers,
        });
      }).catch(function () { return resp; });
    } catch (e) { return resp; }
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
          set: function (v) { stripAds(v); _saved[name] = v; },
        });
      } catch (e) {}
    });
  } catch (e) {}

  // ── 1b. fetch() interception ───────────────────────────────────────────────
  // Requests are never answered locally: an ad endpoint that gets a fabricated
  // response (an empty `{}`, or `about:blank` for the XHR path) makes YouTube's
  // player tear the stream down instead of playing the video, so the ad is
  // removed from the *response* below and any ad that still slips through is
  // skipped client-side. See docs/blocking.md, "Why requests are not faked".
  try {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (PLAYER_RE.test(url) && init && typeof init.body === 'string') {
        var clean = stripRequestAds(init.body);
        if (clean !== null) init = Object.assign({}, init, { body: clean });
      }
      var p = _fetch.call(this, input, init);
      if (PLAYER_RE.test(url)) {
        return p.then(function (resp) {
          try { return pruneFetchResponse(resp); } catch (e) { return resp; }
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
            if (bodyClean !== null) arguments[0] = bodyClean;
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
  // 2. Skip / force-end any ad that still plays
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
      repairBlockedVideo();
      repairStalledVideo();
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
  // 2b. The two repairs uBlock Origin does that a response prune cannot
  // ═══════════════════════════════════════════════════════════════════════════
  // nano-stb (uBO's adjust-setTimeout): YouTube opens an ad by scheduling a 17 s
  // countdown and only then asking the player for the ad. Compressing that one
  // delay to ~17 ms is uBO's `nano-stb, [native code], 17000, 0.001` rule — no
  // other delay is touched — and it ends an ad that has no skip button without
  // seeking the media element (which SSAP ads ignore anyway).
  function scaleAdTimers() {
    var _setTimeout = window.setTimeout;
    if (!_setTimeout || _setTimeout.__omarchyScaled) return;
    var wrapped = function (fn, delay) {
      try {
        if (delay === 17000) arguments[1] = 17;
      } catch (e) {}
      return _setTimeout.apply(this, arguments);
    };
    wrapped.__omarchyScaled = true;
    window.setTimeout = wrapped;
  }

  // The other half of uBO's rpnt scriptlet. An ad-blocked watch page can come
  // back UNPLAYABLE with a "web page type unknown" subreason pointing at
  // support.google.com/youtube/answer/3037019; the player cannot recover from
  // that on its own, but loading the same id again can. Once per id per 30 s, so
  // a genuinely broken video does not turn into a reload loop.
  function adBlockedUnplayable(response) {
    try {
      var status = response && response.playabilityStatus;
      if (!status || status.status !== 'UNPLAYABLE') return false;
      var screen = status.errorScreen || {};
      if (screen.playerCaptchaViewModel) return false;        // a captcha is not this error
      var sub = screen.playerErrorMessageRenderer && screen.playerErrorMessageRenderer.subreason;
      var text = JSON.stringify((sub && sub.runs) || []);
      return text.indexOf('WEB_PAGE_TYPE_UNKNOWN') !== -1 &&
             text.indexOf('3037019') !== -1;
    } catch (e) { return false; }
  }

  var repair = { id: null, at: 0 };

  function repairBlockedVideo(now) {
    try {
      var player = document.querySelector('#movie_player, .html5-video-player');
      if (!player || typeof player.getPlayerResponse !== 'function') return false;
      var response = player.getPlayerResponse();
      if (!adBlockedUnplayable(response)) return false;
      var id = response.videoDetails && response.videoDetails.videoId;
      if (!id) return false;
      now = now || Date.now();
      if (repair.id === id && now - repair.at < 30000) return false;
      repair.id = id;
      repair.at = now;
      var start = (response.playerConfig &&
                   response.playerConfig.playbackStartConfig &&
                   response.playerConfig.playbackStartConfig.startSeconds) || 0;
      if (typeof player.loadVideoById === 'function') player.loadVideoById(id, start);
      return true;
    } catch (e) { return false; }
  }

  // A pruned ad payload can leave the player wedged: at a scheduled mid-roll the
  // stream detaches — duration goes NaN, readyState 0, state -1 — and it never
  // recovers on its own. uBO's rpnt scriptlet handles this by watching progress
  // rather than waiting for an error code; same here. Three consecutive polls
  // with no media (or no movement while supposedly playing) re-load the same id
  // at the last known second, at most once per 30 s per video.
  var progress = { id: null, t: 0, dur: 0, stuck: 0, at: 0 };

  function repairStalledVideo(now) {
    try {
      var player = document.querySelector('#movie_player, .html5-video-player');
      var video = document.querySelector('video.html5-main-video, video');
      if (!player || !video) return false;
      var id = (typeof sbVideoId === 'function') ? sbVideoId() : '';
      if (!id) return false;
      if (id !== progress.id) {
        progress.id = id; progress.t = 0; progress.dur = 0;
        progress.stuck = 0; progress.at = 0;
      }
      if (adShowing(player)) {          // an ad's own stall is what we are here to end
        progress.stuck = 0;
        return false;
      }
      var state = player.getPlayerState ? player.getPlayerState() : 1;
      var known = progress.dur > 0;                     // after the first good sample
      var moved = Math.abs(video.currentTime - progress.t) > 0.25;
      // no media at all after we know there was some, or "playing" without progress
      var dead = known && (!isFinite(video.duration) || video.readyState < 1) && state !== 2;
      var stalled = known && state === 1 && !moved;
      if (dead || stalled) {
        progress.stuck++;
      } else {
        progress.stuck = 0;
        progress.t = video.currentTime;
      }
      if (isFinite(video.duration) && video.duration > 0) progress.dur = video.duration;
      if (progress.stuck < 3) return false;
      progress.stuck = 0;
      now = now || Date.now();
      if (progress.at && now - progress.at < 30000) return false;
      progress.at = now;
      var resume = progress.t > 1 ? Math.max(0, progress.t - 1) : 0;
      if (typeof player.loadVideoById === 'function') player.loadVideoById(id, resume);
      return true;
    } catch (e) { return false; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. SponsorBlock — skip sponsor / self-promo / intro / outro segments
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
  SB.fullWarnedFor = false;      // per video: it is a global, so the toast fired once ever
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
        repairBlockedVideo();
        repairStalledVideo();
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

  // Compress YouTube's 17 s ad countdown (nano-stb) before any player code runs.
  try { scaleAdTimers(); } catch (e) {}

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

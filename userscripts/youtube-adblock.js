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
  ];

  function stripAds(obj) {
    try {
      if (!obj || typeof obj !== 'object') return obj;
      for (var i = 0; i < AD_FIELDS.length; i++) {
        if (Object.prototype.hasOwnProperty.call(obj, AD_FIELDS[i])) {
          try { delete obj[AD_FIELDS[i]]; } catch (e) { obj[AD_FIELDS[i]] = undefined; }
        }
      }
      if (obj.playerResponse) stripAds(obj.playerResponse);      // /youtubei/v1/next
      if (obj.streamingData) {                                   // SSAI remnants
        delete obj.streamingData.adPlacements;
        delete obj.streamingData.adSlots;
      }
      if (obj.playerOverlays && obj.playerOverlays.playerOverlayRenderer) {
        var por = obj.playerOverlays.playerOverlayRenderer;
        delete por.adSlots;
        if (por.playerOverlayRenderer) {
          delete por.playerOverlayRenderer.adSlots;
          delete por.playerOverlayRenderer.adPlacements;
        }
      }
    } catch (e) {}
    return obj;
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
      var p = _fetch.apply(this, arguments);
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
    XMLHttpRequest.prototype.send = function () {
      try {
        var self = this;
        if (self.__yt_url && PLAYER_RE.test(self.__yt_url)) {
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

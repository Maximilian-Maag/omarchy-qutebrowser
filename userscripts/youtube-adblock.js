// ==UserScript==
// @name         YouTube Ad-Free
// @description  Skip and remove YouTube ads for qutebrowser
// @version      2.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── Ad URL patterns to intercept ──────────────────────────────────────────
  var AD_URL_PATTERNS = [
    /doubleclick\.net/,
    /googleadservices\.com/,
    /googlesyndication\.com/,
    /youtube\.com\/pagead\//,
    /youtube\.com\/ptracking/,
    /youtube\.com\/api\/stats\/ads/,
    /youtube\.com\/get_video_info.*adformat/,
  ];

  function isAdUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return AD_URL_PATTERNS.some(function(p) { return p.test(url); });
  }

  // ── 1. Intercept fetch — installed at document-start before YT scripts ────
  try {
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isAdUrl(url)) {
          return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
      } catch(e) {}
      return _fetch.apply(this, arguments);
    };
  } catch(e) {}

  // ── 2. Intercept XHR — installed at document-start ───────────────────────
  try {
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (typeof url === 'string' && isAdUrl(url)) {
          arguments[1] = 'about:blank';
        }
      } catch(e) {}
      return _xhrOpen.apply(this, arguments);
    };
  } catch(e) {}

  // ── Ad DOM selectors ──────────────────────────────────────────────────────
  var AD_SELECTORS = [
    'ytd-ad-slot-renderer',
    'ytd-banner-promo-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-display-ad-renderer',
    'ytd-search-pyv-renderer',
    '#masthead-ad',
    '#player-ads',
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    '.ytp-ad-progress-list',
    '#ad-container',
    '.ytd-companion-slot-renderer',
  ].join(',');

  // ── 3. Remove ad DOM elements ─────────────────────────────────────────────
  function removeAdElements() {
    try {
      var els = document.querySelectorAll(AD_SELECTORS);
      for (var i = 0; i < els.length; i++) {
        try { els[i].remove(); } catch(e) {}
      }
    } catch(e) {}
  }

  // ── 4. Skip / end the current ad ─────────────────────────────────────────
  function skipAd() {
    try {
      var btn = document.querySelector(
        '.ytp-skip-ad-button, .ytp-ad-skip-button, ' +
        '.ytp-ad-skip-button-modern, [class*="skip-button"]'
      );
      if (btn) { btn.click(); return true; }
    } catch(e) {}
    return false;
  }

  function endAd() {
    try {
      var adOverlay = document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module');
      if (!adOverlay) return false;
      var video = document.querySelector('video');
      if (!video) return false;
      var dur = video.duration;
      if (dur && isFinite(dur) && dur > 0) {
        video.currentTime = dur;
        return true;
      }
    } catch(e) {}
    return false;
  }

  // ── 5. Poll while ad is showing ───────────────────────────────────────────
  var skipInterval = null;

  function startSkipPolling() {
    if (skipInterval) return;
    skipInterval = setInterval(function() {
      try {
        var adShowing = document.querySelector('.ad-showing, .ytp-ad-player-overlay');
        if (!adShowing) {
          clearInterval(skipInterval);
          skipInterval = null;
          return;
        }
        if (!skipAd()) endAd();
      } catch(e) {
        clearInterval(skipInterval);
        skipInterval = null;
      }
    }, 200);
  }

  // ── 6. MutationObserver for dynamically injected ads ─────────────────────
  function onMutation() {
    try {
      removeAdElements();
      if (document.querySelector('.ad-showing, .ytp-ad-player-overlay')) {
        startSkipPolling();
      }
    } catch(e) {}
  }

  var observer = new MutationObserver(onMutation);

  function startObserver() {
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: false,
      });
    } catch(e) {}
  }

  // ── 7. SPA navigation — YouTube fires yt-navigate-finish on every page ───
  // Re-run cleanup after each SPA navigation so ads injected post-navigation
  // are caught immediately without waiting for the observer to fire.
  document.addEventListener('yt-navigate-finish', function() {
    try {
      removeAdElements();
      skipAd() || endAd();
    } catch(e) {}
  });

  document.addEventListener('yt-page-data-updated', function() {
    try { removeAdElements(); } catch(e) {}
  });

  // ── 8. Boot ───────────────────────────────────────────────────────────────
  // DOMContentLoaded fires after document-start; by then elements exist.
  document.addEventListener('DOMContentLoaded', function() {
    try {
      removeAdElements();
      skipAd() || endAd();
      startObserver();
    } catch(e) {}
  });

  // Also start observer immediately if document is already interactive/complete.
  if (document.readyState !== 'loading') {
    try {
      removeAdElements();
      startObserver();
    } catch(e) {}
  }
})();

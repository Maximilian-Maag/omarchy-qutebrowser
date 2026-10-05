// ==UserScript==
// @name         YouTube Ad-Free
// @description  Skip and remove YouTube ads — works with qutebrowser's built-in Greasemonkey engine
// @version      1.3
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── 1. Skip any ad that has a skip button ──────────────────────────────
  function skipAd() {
    const skipBtn = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button, ' +
      '.ytp-ad-skip-button-modern, [class*="skip-button"]'
    );
    if (skipBtn) {
      skipBtn.click();
      return true;
    }
    return false;
  }

  // ── 2. Jump the video to its end so non-skippable ads finish instantly ─
  function endAd() {
    const video = document.querySelector('video');
    if (!video) return false;

    // The ad overlay is present
    const adOverlay = document.querySelector(
      '.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module'
    );
    if (!adOverlay) return false;

    if (isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration;
      return true;
    }
    return false;
  }

  // ── 3. Remove ad elements from the DOM ────────────────────────────────
  const AD_SELECTORS = [
    // In-page banners and overlays
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
    // Sidebar ads
    '#ad-container',
    '.ytd-companion-slot-renderer',
    // Shorts ads
    'ytd-reel-player-overlay-renderer [is-ad-shown]',
  ];

  function removeAdElements() {
    for (const sel of AD_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        el.remove();
      }
    }
  }

  // ── 4. Intercept XHR / fetch for ad requests ──────────────────────────
  // Block calls to googlevideo.com ad endpoints and YouTube's own ad API.
  const AD_URL_PATTERNS = [
    /doubleclick\.net/,
    /googleadservices\.com/,
    /googlesyndication\.com/,
    /youtube\.com\/pagead\//,
    /youtube\.com\/ptracking/,
    /youtube\.com\/api\/stats\/ads/,
  ];

  function isAdUrl(url) {
    return AD_URL_PATTERNS.some(p => p.test(url));
  }

  // Wrap fetch
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input.url || '');
    if (isAdUrl(url)) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return _fetch.apply(this, arguments);
  };

  // Wrap XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && isAdUrl(url)) {
      // Redirect to a benign endpoint
      arguments[1] = 'about:blank';
    }
    return _open.apply(this, arguments);
  };

  // ── 5. MutationObserver: catch dynamically injected ads ───────────────
  let skipInterval = null;

  function onMutation() {
    removeAdElements();

    const adShowing = document.querySelector(
      '.ad-showing, .ytp-ad-player-overlay'
    );

    if (adShowing) {
      if (!skipInterval) {
        skipInterval = setInterval(() => {
          if (!skipAd()) endAd();
          // Stop once the ad is gone
          if (!document.querySelector('.ad-showing, .ytp-ad-player-overlay')) {
            clearInterval(skipInterval);
            skipInterval = null;
          }
        }, 200);
      }
    }
  }

  // ── 6. Boot ────────────────────────────────────────────────────────────
  removeAdElements();

  const observer = new MutationObserver(onMutation);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
  });

  // Also run once the full page is ready
  document.addEventListener('DOMContentLoaded', () => {
    removeAdElements();
    skipAd() || endAd();
  });
})();

// ==UserScript==
// @name         Cookie Banner Remover
// @description  Dismiss and hide cookie consent banners — belt-and-suspenders alongside filter lists
// @version      1.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── 1. Common cookie banner selectors ─────────────────────────────────────
  // Covers the most common CMPs and generic patterns.
  var BANNER_SELECTORS = [
    // Generic id/class patterns
    '#cookie-banner', '#cookie-notice', '#cookie-consent', '#cookie-popup',
    '#cookie-bar', '#cookie-dialog', '#cookie-overlay', '#cookie-modal',
    '#cookiebanner', '#cookienotice', '#cookieconsent', '#cookiepopup',
    '#cookieConsent', '#cookieBanner', '#cookieNotice', '#cookieBar',
    '.cookie-banner', '.cookie-notice', '.cookie-consent', '.cookie-popup',
    '.cookie-bar', '.cookie-dialog', '.cookie-overlay', '.cookie-modal',
    '.cookiebanner', '.cookienotice', '.cookieconsent', '.cookiepopup',
    '.cookie-policy', '.cookie-policy-banner', '.cookie-policy-popup',
    // GDPR / consent generic
    '#gdpr-banner', '#gdpr-consent', '#gdpr-popup', '#gdpr-notice',
    '.gdpr-banner', '.gdpr-consent', '.gdpr-popup', '.gdpr-notice',
    '#consent-banner', '#consent-modal', '#consent-popup', '#consent-dialog',
    '.consent-banner', '.consent-modal', '.consent-popup', '.consent-dialog',
    // Specific CMPs
    '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.optanon-alert-box-wrapper',
    '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '.cc-window',
    '#hs-eu-cookie-confirmation', '#cookieChoiceInfo', '.cookie-law-info-bar',
    '.pea_cook_wrapper', '#cookie-law-info-cookie-id',
    '[id*="cookieConsent"]', '[id*="CookieConsent"]',
    '[id*="cookie-consent"]', '[id*="cookiebanner"]',
    '[class*="cookieBanner"]', '[class*="CookieBanner"]',
    '[class*="cookie-banner"]', '[class*="cookie-consent"]',
    '[class*="CookieConsent"]', '[class*="gdpr-banner"]',
    '[class*="consent-banner"]', '[class*="consentBanner"]',
    // Overlay backdrops left behind
    '.cookie-overlay', '.gdpr-overlay', '.consent-overlay',
    '[class*="cookieOverlay"]', '[class*="gdprOverlay"]',
  ].join(',');

  // ── 2. Remove matching elements ───────────────────────────────────────────
  function removeBanners() {
    try {
      var els = document.querySelectorAll(BANNER_SELECTORS);
      for (var i = 0; i < els.length; i++) {
        try { els[i].remove(); } catch(e) {}
      }
    } catch(e) {}
  }

  // ── 3. Restore scroll lock often applied by CMPs ──────────────────────────
  function restoreScroll() {
    try {
      var html = document.documentElement;
      var body = document.body;
      if (!html || !body) return;
      // Remove overflow:hidden / position:fixed that banners apply to body
      var htmlStyle = window.getComputedStyle(html);
      var bodyStyle = window.getComputedStyle(body);
      if (htmlStyle.overflow === 'hidden') html.style.overflow = '';
      if (bodyStyle.overflow === 'hidden') body.style.overflow = '';
      if (htmlStyle.position === 'fixed')  html.style.position = '';
      if (bodyStyle.position === 'fixed')  body.style.position = '';
      if (body.style.top && body.style.position === 'fixed') {
        var scrollY = parseInt(body.style.top || '0', 10) * -1;
        body.style.position = '';
        body.style.top = '';
        window.scrollTo(0, scrollY);
      }
    } catch(e) {}
  }

  // ── 4. Auto-click "Accept" / "Reject" / "Close" buttons ──────────────────
  // Prefer "Reject all" > "Necessary only" > "Close" > "Accept"
  // We never auto-accept — we reject or dismiss.
  var REJECT_PATTERNS = [
    /reject\s*all/i, /decline\s*all/i, /deny\s*all/i,
    /refuse\s*all/i, /refuse/i, /decline/i,
    /necessary\s*only/i, /only\s*necessary/i, /essential\s*only/i,
    /only\s*essential/i, /manage\s*preferences/i,
    /save\s*(preferences|settings)/i,
    /close/i, /dismiss/i, /\bno\b/i,
  ];
  var ACCEPT_PATTERNS = [
    /accept\s*all/i, /allow\s*all/i, /agree/i, /i\s*accept/i,
  ];

  function scoreButton(btn) {
    var text = (btn.innerText || btn.textContent || btn.value || btn.title || '').trim();
    for (var i = 0; i < REJECT_PATTERNS.length; i++) {
      if (REJECT_PATTERNS[i].test(text)) return 100 - i; // higher = more preferred
    }
    for (var j = 0; j < ACCEPT_PATTERNS.length; j++) {
      if (ACCEPT_PATTERNS[j].test(text)) return -1; // avoid
    }
    return 0;
  }

  function clickBestButton(root) {
    try {
      var candidates = root.querySelectorAll(
        'button, [role="button"], input[type="button"], input[type="submit"], a[href="#"]'
      );
      var best = null, bestScore = 0;
      for (var i = 0; i < candidates.length; i++) {
        var s = scoreButton(candidates[i]);
        if (s > bestScore) { bestScore = s; best = candidates[i]; }
      }
      if (best && bestScore > 0) {
        best.click();
        return true;
      }
    } catch(e) {}
    return false;
  }

  // ── 5. Process a banner element: click reject or remove ───────────────────
  function processBanner(el) {
    if (!clickBestButton(el)) {
      try { el.remove(); } catch(e) {}
    }
    restoreScroll();
  }

  // ── 6. MutationObserver for dynamically injected banners ──────────────────
  function onMutation(mutations) {
    try {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.nodeType !== 1) continue;
          // Check if added node itself matches
          try {
            if (node.matches && node.matches(BANNER_SELECTORS)) {
              processBanner(node);
              continue;
            }
          } catch(e) {}
          // Check descendants
          try {
            var found = node.querySelector && node.querySelector(BANNER_SELECTORS);
            if (found) processBanner(found.closest('[id],[class]') || found);
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  // ── 7. Boot ───────────────────────────────────────────────────────────────
  removeBanners();
  restoreScroll();

  // Also try clicking reject on any banners already present
  try {
    var banners = document.querySelectorAll(BANNER_SELECTORS);
    for (var i = 0; i < banners.length; i++) {
      processBanner(banners[i]);
    }
  } catch(e) {}

  new MutationObserver(onMutation).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Final sweep after a brief delay for late-loading CMPs
  setTimeout(function() {
    try {
      removeBanners();
      restoreScroll();
      var banners = document.querySelectorAll(BANNER_SELECTORS);
      for (var i = 0; i < banners.length; i++) processBanner(banners[i]);
    } catch(e) {}
  }, 1500);
})();

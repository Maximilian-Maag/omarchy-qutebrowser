// ==UserScript==
// @name         Cookie Banner Remover (Omarchy)
// @description  Dismiss/hide cookie-consent banners & consent walls across major CMPs (incl. Sourcepoint used by golem.de/heise.de), plus a generic overlay fallback. Belt-and-suspenders alongside the filter lists.
// @version      3.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── 1. CMP containers / overlays ──────────────────────────────────────────
  // Explicit selectors for the CMPs seen in the wild, then generic patterns.
  var CMP_SELECTORS = [
    // Sourcepoint (golem.de, heise.de, and many news sites) — first-party or CDN.
    '[id^="sp_message_container"]', '[id^="sp_message_iframe"]',
    '.sp_message_container', '.sp_veil', '#sp_veil', '.sp-overlay', '.sp_choice_type_wrapper',
    'div[class*="sp_message"]', 'iframe[src*="privacy-mgmt.com"]', 'iframe[src*="/index.html?message_id="]',
    // golem.de inline hint
    '#gspcookiehint', '#gspiframehint',
    // OneTrust
    '#onetrust-banner-sdk', '#onetrust-consent-sdk', '#onetrust-pc-sdk', '.onetrust-pc-dark-filter',
    '#ot-sdk-btn-floating', '.ot-fade-in',
    // Cookiebot
    '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#CookiebotWidget',
    // Usercentrics
    '#usercentrics-root', '#usercentrics-cmp-ui', '#uc-center-container', 'uc-wall', '[data-testid="uc-default-wall"]', '.uc-banner',
    // Didomi
    '#didomi-host', '.didomi-popup-container', '.didomi-notice-banner', '.didomi-consent-popup',
    // CCM19 (DE)
    '#ccm', '#ccm-control-container', '.ccm-root', '#ccm-widget', '.ccm-modal',
    // Borlabs Cookie (DE)
    '#BorlabsCookieBox', '#BorlabsCookieWidget', '.borlabs-cookie', '.BorlabsCookie',
    // Klaro
    '.klaro', '#klaro', '.cm-modal', '.cookie-modal',
    // consentmanager.net (.cmpbox / #cmpbox)
    '#cmpbox', '#cmpbox2', '.cmpbox', '#cmpwrapper', '#cmpboxBackdrop', '[id^="cmpbox"]', '.cmpboxreset',
    // Quantcast Choice
    '#qc-cmp2-container', '.qc-cmp2-container', '#qcCmpUi', '.qc-cmp-ui-container',
    // iubenda
    '#iubenda-cs-banner', '.iubenda-cs-container', '#iubenda-iframe', '.iubenda-cs-overlay', '.iubenda-cs-opt-group',
    // Osano
    '.osano-cm-window', '.osano-cm-dialog', '.osano-cm-widget',
    // TrustArc
    '#truste-consent-track', '.truste_box_overlay', '.truste_overlay', '#truste-consent-content', '#consent_blackbar',
    // Google Funding Choices / consent
    '.fc-consent-root', '.fc-dialog-overlay', '.fc-monetization-dialog-container', '.fc-consent-header', '[id^="google-revocation-link"]',
    // CookieYes / Cookie Law Info
    '.cky-consent-container', '.cky-overlay', '#cookie-law-info-bar', '#cookie-law-info-again', '.cli-modal-backdrop',
    // Complianz (WP)
    '.cmplz-cookiebanner', '#cmplz-cookiebanner-container', '.cmplz-blocked-content-notice',
    // CookieFirst / Cookiehub / CookieNotice
    '#cookiefirst-root', '.cookiefirst-root', '.cookiehub', '.cookie-notice-container', '#cookie-notice',
    // Termly / Segmanta / common WP plugins
    '[class*="termly"]', '.termly-cookie-policy-widget', '#moove_gdpr_cookie_info_bar', '.moove-gdpr-info-bar-container',
    // Other common ones
    '.cc-window', '#hs-eu-cookie-confirmation', '#cookieChoiceInfo', '.pea_cook_wrapper',
    '.cookieConsent', '#cookieConsent', '.cc_banner', '#cookiescript_injected', '.cookiescript_injected',
    '#trustarc-banner-container', '.introjs-overlay', '#gdpr-banner', '.gdpr-banner',
    '#consent-banner', '.consent-banner', '.cookie-banner', '.cookie-consent', '.cookie-popup',
    // Generic attribute patterns
    '[id*="cookie-consent" i]', '[id*="cookieConsent"]', '[id*="cookiebanner" i]', '[id*="cookie-banner" i]',
    '[class*="cookie-banner" i]', '[class*="cookie-consent" i]', '[class*="CookieBanner"]', '[class*="CookieConsent"]',
    '[id*="consent-manager" i]', '[class*="consent-manager" i]', '[class*="gdpr" i]', '[id*="gdpr" i]',
    '[aria-label*="cookie" i][role="dialog"]', '[aria-label*="consent" i][role="dialog"]', '[aria-label*="privacy" i][role="dialog"]',
  ].join(',');

  // Scroll-lock classes CMPs add to <html>/<body> that must be removed.
  var UNLOCK_CLASSES = [
    'sp-message-open', 'didomi-popup-open', 'ccm-blocked', 'ccm--open', 'cmp-open',
    'cookie-consent-open', 'modal-open', 'no-scroll', 'overflow-hidden', 'has-cookie-banner',
    'fc-consent-root', 'sp-message-open-', 'usercentrics-modal-open', 'cookiebanner-open',
  ];

  var REJECT_PATTERNS = [
    /reject\s*all/i, /decline\s*all/i, /deny\s*all/i, /refuse\s*all/i, /ablehnen/i,
    /reject\s*(optional|non[-\s]?essential|all\s*optional)/i, /alle\s*ablehnen/i,
    /necessary\s*only/i, /only\s*necessary/i, /essential\s*only/i, /only\s*essential/i,
    /nur\s*(notwendige|erforderliche|essen)/i, /nicht\s*zustimmen/i,
    /manage\s*(options|preferences|consent|settings)/i, /save\s*(preferences|settings|choices|selection)/i,
    /^(close|dismiss|no,?\s*thanks|not\s*now|got\s*it|schlie[ßs]en|sp[äa]ter)[.!]?$/i,
  ];
  var ACCEPT_PATTERNS = [/accept\s*all/i, /allow\s*all/i, /agree/i, /i\s*accept/i, /akzeptieren/i, /einverstanden/i, /zustimmen/i];

  function isVisible(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  function removeMatching(root) {
    try {
      var els = (root || document).querySelectorAll(CMP_SELECTORS);
      for (var i = 0; i < els.length; i++) {
        try { els[i].remove(); } catch (e) {}
      }
    } catch (e) {}
  }

  // Remove any element (scoping to the banner, not the page) that looks like a CMP.
  function dropAncestor(el) {
    try {
      var n = el;
      for (var k = 0; k < 6 && n && n !== document.body && n !== document.documentElement; k++) {
        var s = ((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase();
        if (/consent|cookie|privacy|gdpr|sp_message|sp-message|didomi|usercentrics|onetrust|cmp|veil|banner|overlay|paywall/.test(s)) {
          n.remove(); return true;
        }
        n = n.parentElement;
      }
    } catch (e) {}
    return false;
  }

  function unlockScroll() {
    try {
      [document.documentElement, document.body].forEach(function (el) {
        if (!el) return;
        for (var i = 0; i < UNLOCK_CLASSES.length; i++) {
          try { el.classList.remove(UNLOCK_CLASSES[i]); } catch (e) {}
        }
        var cs = window.getComputedStyle(el);
        if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') el.style.overflow = '';
        if (cs.position === 'fixed' && el.tagName === 'BODY') el.style.position = '';
      });
    } catch (e) {}
  }

  function scoreButton(btn) {
    var text = (btn.innerText || btn.textContent || btn.value || btn.title || btn.getAttribute('aria-label') || '').trim();
    for (var i = 0; i < REJECT_PATTERNS.length; i++) if (REJECT_PATTERNS[i].test(text)) return 100 - i;
    for (var j = 0; j < ACCEPT_PATTERNS.length; j++) if (ACCEPT_PATTERNS[j].test(text)) return -1;
    return 0;
  }

  function clickBestButton(root) {
    try {
      var cands = root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href="#"], a[href="javascript:void(0)"]');
      var best = null, bestScore = 0;
      for (var i = 0; i < cands.length; i++) {
        var s = scoreButton(cands[i]);
        if (s > bestScore) { bestScore = s; best = cands[i]; }
      }
      if (best && bestScore > 0) { best.click(); return true; }
    } catch (e) {}
    return false;
  }

  function processBanner(el) {
    if (!clickBestButton(el)) {
      try { el.remove(); } catch (e) {}
    }
    unlockScroll();
  }

  // ── 2. Generic overlay fallback (sites not covered by the selector list) ──
  // A fixed/sticky, high z-index element that covers a big chunk of the viewport
  // and contains consent keywords — click reject, else hide.
  var CONSENT_WORDS = /(cookie|consent|privat|gdpr|dsgvo|datenschutz|tracking|zustimm|akzeptier|einverstand|privacy|advert)/i;
  function genericOverlaySweep() {
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      // Snapshot: document.body.children is a LIVE collection, and processBanner()
      // / remove() shifts it, so looping it directly skips the element that slides
      // into the current index (a second overlay survived the pass).
      var nodes = document.body ? Array.prototype.slice.call(document.body.children) : [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!isVisible(el)) continue;
        var s = window.getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') continue;
        var z = parseInt(s.zIndex, 10);
        if (!(z >= 1000)) continue;
        var r = el.getBoundingClientRect();
        if (r.width * r.height < 0.25 * vw * vh) continue;
        var txt = (el.innerText || '').slice(0, 4000);
        if (!CONSENT_WORDS.test(txt)) continue;
        if (el.querySelector('button, [role="button"], input[type="submit"], a')) {
          processBanner(el);
        } else {
          try { el.remove(); } catch (e) {}
          unlockScroll();
        }
      }
    } catch (e) {}
  }

  // Elements whose *own* text matches and which are fixed/high-z but not direct
  // children of body (some CMPs nest), handled via CMP_SELECTORS only.

  // ── 3. Sweep + observe ────────────────────────────────────────────────────
  function sweep() {
    removeMatching(document);
    unlockScroll();
  }

  function onMutation() {
    try {
      removeMatching(document);
      genericOverlaySweep();
    } catch (e) {}
  }

  // Initial passes (document-start: elements may not exist yet).
  sweep();
  genericOverlaySweep();
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', function () { sweep(); genericOverlaySweep(); });
    window.addEventListener('load', function () { sweep(); genericOverlaySweep(); });
  }

  // CMPs inject late (1–5s); sweep a few times.
  [300, 800, 1500, 2500, 4000].forEach(function (ms) {
    setTimeout(function () { sweep(); genericOverlaySweep(); }, ms);
  });

  var observer = new MutationObserver(onMutation);
  function startObserver() {
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // SPA navigations
  try {
    ['yt-navigate-finish', 'yt-page-data-updated', 'turbo:load', 'pjax:end'].forEach(function (ev) {
      document.addEventListener(ev, function () { sweep(); genericOverlaySweep(); });
    });
    window.addEventListener('popstate', function () { setTimeout(function () { sweep(); genericOverlaySweep(); }, 500); });
  } catch (e) {}
})();

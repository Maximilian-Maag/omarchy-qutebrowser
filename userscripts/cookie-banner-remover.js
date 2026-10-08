// ==UserScript==
// @name         Cookie Banner Remover + Adblock Defuser (Omarchy)
// @description  Automatic, reject-by-default cookie-consent handling: click "reject all" when it exists, fall back to accept only when there is no reject option, and remove the banner either way. Also defuses anti-adblock detection and removes "disable your ad blocker" walls (e.g. bild.de), plus a generic overlay fallback.
// @version      4.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // What the script decided, per page — this is what the tests assert on.
  var log = [];
  try { window.__omarchyConsent = log; } catch (e) {}
  function note(action, detail) {
    try { log.push({ action: action, detail: (detail || '').slice(0, 80), at: Date.now() }); } catch (e) {}
  }

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

  // REJECT first — this is the policy. "only necessary"/"save preferences" count
  // as a rejection too (they leave optional categories off).
  var REJECT_PATTERNS = [
    /reject\s*all/i, /decline\s*all/i, /deny\s*all/i, /refuse\s*all/i, /ablehnen/i,
    /reject\s*(optional|non[-\s]?essential|all\s*optional)/i, /alle\s*ablehnen/i,
    /necessary\s*only/i, /only\s*necessary/i, /essential\s*only/i, /only\s*essential/i,
    /nur\s*(notwendige|erforderliche|essen)/i, /nicht\s*zustimmen/i,
    /weiter\s*ohne/i, /ohne\s*zustimmung/i, /optionale?\s*ablehnen/i,
    /manage\s*(options|preferences|consent|settings)/i, /save\s*(preferences|settings|choices|selection)/i,
    /einstellungen\s*(speichern|übernehmen)/i,
    /^(close|dismiss|no,?\s*thanks|not\s*now|got\s*it|schlie[ßs]en|sp[äa]ter)[.!]?$/i,
  ];
  var ACCEPT_PATTERNS = [
    /accept\s*all/i, /allow\s*all/i, /i\s*accept/i, /agree/i,
    /alle\s*akzeptieren/i, /akzeptieren/i, /einverstanden/i, /allen?\s*zustimmen/i, /zustimmen/i,
    /alles\s*(erlauben|annehmen)/i,
  ];

  function label(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || el.value || el.title ||
            el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
  }

  function isVisible(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  // ── The consent decision ──────────────────────────────────────────────────
  // 1. a reject button  -> click it (default policy)
  // 2. otherwise an accept button -> click it, so the site still works
  // 3. otherwise nothing -> the banner is just removed (no consent recorded)
  var BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], a[href="#"], a[href^="javascript:"]';

  function findButton(root, patterns) {
    var cands;
    try { cands = root.querySelectorAll(BUTTONS); } catch (e) { return null; }
    var best = null, bestScore = 0;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var t = label(el);
      if (!t || t.length > 60) continue;          // a consent button is short
      if (!isVisible(el)) continue;
      for (var p = 0; p < patterns.length; p++) {
        if (patterns[p].test(t)) {
          var score = patterns.length - p;        // earlier pattern = better
          if (score > bestScore) { bestScore = score; best = el; }
          break;
        }
      }
    }
    return best;
  }

  // A bare .click() is ignored by consent managers that listen for pointer events
  // (the same lesson as the password-fill userscript), so send the whole sequence.
  function press(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      try {
        var Ctor = (type.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    });
    try { el.click(); } catch (e) {}
  }

  function decideConsent(root) {
    var scope = root || document;
    var btn = findButton(scope, REJECT_PATTERNS);
    if (btn) { press(btn); return 'reject'; }
    btn = findButton(scope, ACCEPT_PATTERNS);
    if (btn) { press(btn); return 'accept'; }
    return null;
  }

  // ── Every document we can reach ───────────────────────────────────────────
  // Newer consent managers render inside an open shadow root, and some sit in a
  // same-origin iframe; both were invisible to sweeps that only looked at
  // `document`. Cross-origin frames throw and are skipped.
  function roots() {
    var out = [document];
    try {
      var els = document.querySelectorAll('*');
      for (var i = 0; i < els.length && out.length < 60 && i < 4000; i++) {
        var sr = els[i].shadowRoot;
        if (!sr) continue;
        out.push(sr);
        var inner = sr.querySelectorAll('*');
        for (var j = 0; j < inner.length && out.length < 60 && j < 1000; j++) {
          if (inner[j].shadowRoot) out.push(inner[j].shadowRoot);
        }
      }
      var frames = document.querySelectorAll('iframe');
      for (var k = 0; k < frames.length && out.length < 60; k++) {
        try {
          var doc = frames[k].contentDocument;      // throws if cross-origin
          if (doc) out.push(doc);
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  // The fixed/sticky thing that holds a consent button (the thing to take away).
  function bannerFor(btn, root) {
    var doc = (root && root.ownerDocument) || document;
    var el = btn, hops = 0;
    while (el && el !== doc.body && hops < 12) {
      try {
        var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
        var r = el.getBoundingClientRect();
        if (st && (st.position === 'fixed' || st.position === 'sticky') && r.height > 24) return el;
      } catch (e) { break; }
      el = el.parentElement; hops++;
    }
    return null;
  }

  // Root-aware consent sweep, with a verification pass: if the banner is still
  // there shortly after the click (some CMPs need a moment, or a second event),
  // press again and then simply remove it.
  var lastDeep = 0;
  var handledBanners = new WeakSet();
  function deepConsentSweep() {
    var now = Date.now();
    if (now - lastDeep < 400) return;        // onMutation can fire in bursts
    lastDeep = now;
    var list = roots();
    for (var i = 0; i < list.length; i++) {
      var root = list[i], btn = null;
      try { btn = findButton(root, REJECT_PATTERNS) || findButton(root, ACCEPT_PATTERNS); }
      catch (e) { continue; }
      if (!btn) continue;
      var container = bannerFor(btn, root) || btn;
      if (handledBanners.has(container)) continue;      // one decision per banner
      var action = decideConsent(container);
      if (!action) continue;
      handledBanners.add(container);
      note(action, root === document ? 'banner' : 'banner in shadow/iframe');
      (function (el) {
        if (!el) return;
        setTimeout(function () {
          try {
            if (!el.isConnected) return;
            var again = findButton(el, REJECT_PATTERNS) || findButton(el, ACCEPT_PATTERNS);
            if (again) press(again);
            el.remove();
            note('removed', 'banner did not go away after the click');
            unlockScroll();
          } catch (e) {}
        }, 800);
      })(container);
    }
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

  function removeMatching(root) {
    try {
      var els = (root || document).querySelectorAll(CMP_SELECTORS);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.isConnected) continue;
        var action = decideConsent(el);          // record the choice first…
        note(action || 'removed', (el.id || el.className || el.tagName) + '');
        try { el.remove(); } catch (e) {}        // …then take the banner away
      }
    } catch (e) {}
  }

  // ── 2. Generic overlay fallback (sites not covered by the selector list) ──
  // A fixed/sticky, high z-index element that covers a big chunk of the viewport
  // and talks about cookies/consent — same decision ladder, then hide.
  var CONSENT_WORDS = /(cookie|consent|privat|gdpr|dsgvo|datenschutz|tracking|zustimm|akzeptier|einverstand|privacy|advert)/i;
  function genericOverlaySweep() {
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      // Snapshot: document.body.children is a LIVE collection, and remove() shifts
      // it, so looping it directly skips the element that slides into the index.
      var nodes = document.body ? Array.prototype.slice.call(document.body.children) : [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || !el.isConnected || !isVisible(el)) continue;
        var s = window.getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') continue;
        var z = parseInt(s.zIndex, 10);
        if (!(z >= 1000)) continue;
        var r = el.getBoundingClientRect();
        if (r.width * r.height < 0.25 * vw * vh) continue;
        var txt = (el.innerText || '').slice(0, 4000);
        if (!CONSENT_WORDS.test(txt)) continue;
        var action = decideConsent(el);
        note(action || 'removed', 'overlay ' + (el.id || el.className || el.tagName));
        try { el.remove(); } catch (e) {}
        unlockScroll();
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Anti-adblock defusing
  //    The filter lists block ads, so a site runs its own detection: it plants a
  //    "bait" element (class ad-banner / adsbox / …), sees that it has no size or
  //    that window.adsbygoogle is missing, concludes "adblocker", and covers the
  //    article with a wall (bild.de and many German news sites do this).
  //    Make the detection find nothing, and remove a wall if one still appears.
  // ═══════════════════════════════════════════════════════════════════════════
  var BAIT_CLASSES = 'ad-banner adsbox ad-placement adBanner adPlacement text-ad textAd ' +
                     'sponsored-ad sponsoredAd ad-slot ad-slot-container ad-container ad-wrapper ' +
                     'advert advertisement banner-ad pub_300x250 pub_300x250m pub_728x90';
  var BAIT_RE = /(^|[\s-])(ad[-_]?(banner|box|placement|slot|container|wrapper|sbox)|adsbox|adbn|text[-_]?ad|sponsored[-_]?ad|pub_300x250|pub_728x90)([\s-]|$)/i;

  function isBait(el) {
    try {
      return BAIT_RE.test(String(el.className || '')) || BAIT_RE.test(String(el.id || '')) ||
             BAIT_RE.test(String(el.getAttribute && el.getAttribute('data-ad-slot') || ''));
    } catch (e) { return false; }
  }

  // The filter list *hides* bait elements (`##.adsbox { display:none }`), so a page
  // that measures one sees height 0 and concludes "adblocker". Force the usual
  // bait classes to look like a served ad — via CSS and, because a page may use
  // getBoundingClientRect or offsetHeight instead, by patching the measurements
  // for bait-classed elements only (everything else passes through untouched).
  function unhideBait() {
    try {
      if (document.getElementById('__omarchy_bait_css')) return;
      var st = document.createElement('style');
      st.id = '__omarchy_bait_css';
      st.textContent = BAIT_CLASSES.split(' ').map(function (c) { return '.' + c; }).join(',') +
        '{display:block!important;visibility:visible!important;opacity:1!important;' +
        'position:absolute!important;left:-9999px!important;top:-9999px!important;' +
        'width:300px!important;height:250px!important;}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  function patchBaitMeasure() {
    try {
      if (window.__omarchy_bait_patched) return;
      window.__omarchy_bait_patched = true;
      [['offsetHeight', 250], ['offsetWidth', 300], ['clientHeight', 250], ['clientWidth', 300]].forEach(function (pair) {
        var d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, pair[0]);
        if (!d || !d.get) return;
        Object.defineProperty(HTMLElement.prototype, pair[0], {
          configurable: true,
          get: function () { try { if (isBait(this)) return pair[1]; } catch (e) {} return d.get.call(this); },
        });
      });
      var rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        try {
          if (isBait(this)) {
            var r = rect.call(this);
            if (!r.width || !r.height) {
              return { x: -9999, y: -9999, top: -9999, left: -9999, right: -9699, bottom: -9749,
                       width: 300, height: 250, toJSON: function () { return {}; } };
            }
          }
        } catch (e) {}
        return rect.call(this);
      };
    } catch (e) {}
  }

  function plantBait() {
    try {
      if (document.getElementById('__omarchy_bait')) return;
      var host = document.body || document.documentElement;
      if (!host) return;
      var bait = document.createElement('div');
      bait.id = '__omarchy_bait';
      bait.className = BAIT_CLASSES;
      bait.setAttribute('data-ad-slot', 'omarchy');
      bait.style.cssText = 'position:absolute!important;left:-9999px!important;top:-9999px!important;' +
                           'width:300px!important;height:250px!important;display:block!important;';
      bait.innerHTML = '&nbsp;';
      host.appendChild(bait);
      // the classic check is `bait.offsetHeight === 0` -> "blocked"
      try {
        Object.defineProperty(bait, 'offsetHeight', { configurable: true, get: function () { return 250; } });
        Object.defineProperty(bait, 'offsetWidth', { configurable: true, get: function () { return 300; } });
        Object.defineProperty(bait, 'clientHeight', { configurable: true, get: function () { return 250; } });
      } catch (e) {}
      setTimeout(function () { try { bait.remove(); } catch (e) {} }, 5000);
    } catch (e) {}
  }

  function chainableStub(onNotDetectedCallsBack) {
    var api = {};
    var self = function () { return api; };
    api.setOption = function () { return api; };
    api.setBaitClass = function () { return api; };
    api.setBaitStyle = function () { return api; };
    api.setBait = function () { return api; };
    api.check = function () { return api; };
    api.debug = function () { return api; };
    api.on = function () { return api; };
    api.clearEvent = function () { return api; };
    api.onDetected = function () { return api; };          // never "detected"
    api.onNotDetected = function (cb) { if (onNotDetectedCallsBack && typeof cb === 'function') { try { cb(); } catch (e) {} } return api; };
    return self;
  }

  function defuseFlags() {
    try {
      window.canRunAds = true;
      window.google_ad_status = 1;
      if (typeof window.adblockDetector === 'undefined') window.adblockDetector = { isAdBlockActive: false };
      try { Object.defineProperty(window, 'adBlockDetected', { configurable: true, get: function () { return false; }, set: function () {} }); } catch (e) {}
      if (!window.adsbygoogle || typeof window.adsbygoogle.push !== 'function') {
        var slot = { setTargeting: function () { return slot; }, defineSizeMapping: function () { return slot; },
                     addService: function () { return slot; }, setCollapseEmptyDiv: function () { return slot; },
                     getSlotElementId: function () { return ''; } };
        var ag = { loaded: true, push: function () {}, defineSlot: function () { return slot; },
                   defineOutOfPageSlot: function () { return slot; }, enableServices: function () {},
                   destroySlots: function () {} };
        ag.loaded = true;
        window.adsbygoogle = ag;
      }
      if (typeof window.BlockAdBlock === 'undefined') window.BlockAdBlock = chainableStub(true);
      if (typeof window.blockAdBlock === 'undefined') window.blockAdBlock = window.BlockAdBlock;
      if (typeof window.FuckAdBlock === 'undefined') window.FuckAdBlock = chainableStub(true);
      if (typeof window.fuckAdBlock === 'undefined') window.fuckAdBlock = window.FuckAdBlock;
      if (typeof window.SniffAdBlock === 'undefined') window.SniffAdBlock = chainableStub(true);
      if (typeof window.adBlockDetector === 'undefined') window.adBlockDetector = { init: function () {}, isAdBlockActive: false };
    } catch (e) {}
  }

  var WALL_RE = new RegExp([
    'adblock', 'ad-block', 'werbeblocker', 'werbung\\s*block', 'blocker\\s*erkannt',
    'deaktivieren\\s+sie\\s+(ihn|ihren|den)?\\s*(ad|werbe)', 'bitte\\s+(deaktivieren|schalten)',
    'uBlock', 'AdBlock\\s*Plus', 'Support\\s+(us|uns)', 'Werbung\\s*(aus|anzeigen|entfernen)',
    'schalt\\w*\\s+sie\\s+(werbung|den\\s+adblocker)', 'weiter\\s+ohne\\s+werbung',
    'ohne\\s+werbung\\s+weiter', 'schon\\s+abonniert', 'wir\\s+finanzieren\\s+uns',
    'whitelist', 'add\\s+us\\s+to\\s+your', 'disable\\s+your\\s+ad', 'turn\\s+off\\s+your\\s+ad',
  ].join('|'), 'i');

  var WALL_SELECTORS = [
    '[id*="adblock" i]', '[class*="adblock" i]', '[id*="ad-block" i]', '[class*="ad-block" i]',
    '[id*="antiad" i]', '[class*="antiad" i]', '[class*="werbeblocker" i]', '[id*="werbeblocker" i]',
    '[data-testid*="adblock" i]', '[class*="paywall" i][class*="overlay" i]',
    '[class*="blocker-overlay" i]', '[id*="blocker-overlay" i]',
  ].join(',');

  function dismissWall(el) {
    try {
      // prefer a "continue anyway"/close affordance inside the wall
      var close = findButton(el, [/^(close|dismiss|schlie[ßs]en|weiter|continue|no,?\s*thanks|sp[äa]ter)/i]);
      if (close) { press(close); }
    } catch (e) {}
    try { el.remove(); } catch (e) {}
    unlockScroll();
    note('wall-removed', (el.id || el.className || el.tagName) + '');
  }

  function removeAdblockWalls() {
    try {
      var hits = document.querySelectorAll(WALL_SELECTORS);
      for (var i = 0; i < hits.length; i++) {
        var el = hits[i];
        if (!el || !el.isConnected || !isVisible(el)) continue;
        var r = el.getBoundingClientRect();
        if (r.width * r.height < 0.05 * window.innerWidth * window.innerHeight) continue;
        dismissWall(el);
      }
      // text-based search over full-viewport overlays / dialogs
      var vw = window.innerWidth, vh = window.innerHeight;
      var cands = document.querySelectorAll('div, section, dialog, aside, [role="dialog"], [role="alertdialog"]');
      for (var k = 0; k < cands.length; k++) {
        var e2 = cands[k];
        if (!e2 || !e2.isConnected || !isVisible(e2)) continue;
        var s = window.getComputedStyle(e2);
        var big = (s.position === 'fixed' || s.position === 'absolute') &&
                  parseInt(s.zIndex, 10) >= 500 &&
                  e2.getBoundingClientRect().width * e2.getBoundingClientRect().height >= 0.15 * vw * vh;
        if (!big) continue;
        var t = (e2.innerText || '').replace(/\s+/g, ' ');
        if (t.length < 25 || t.length > 1200 || !WALL_RE.test(t)) continue;
        dismissWall(e2);
      }
    } catch (e) {}
  }

  // ── 4. Consent *bars* ─────────────────────────────────────────────────────
  // A cookie bar is usually a strip at the bottom, far smaller than the overlay
  // sweep's 25% viewport threshold and often not in the CMP list. Find them by
  // their button labels: "Alle ablehnen" is an unambiguous signal. The accept-only
  // fallback additionally requires that the banner really talks about
  // cookies/consent, so an unrelated form is never clicked.
  function barSweep() {
    try {
      var btns = document.querySelectorAll(BUTTONS);
      var seen = [];
      for (var i = 0; i < btns.length && seen.length < 40; i++) {
        var b = btns[i];
        if (!b || !b.isConnected || !isVisible(b)) continue;
        var t = label(b);
        if (!t || t.length > 60) continue;
        var isReject = false, isAccept = false, p;
        for (p = 0; p < REJECT_PATTERNS.length; p++) { if (REJECT_PATTERNS[p].test(t)) { isReject = true; break; } }
        if (!isReject) {
          for (p = 0; p < ACCEPT_PATTERNS.length; p++) { if (ACCEPT_PATTERNS[p].test(t)) { isAccept = true; break; } }
        }
        if (!isReject && !isAccept) continue;
        var el = b, hops = 0, banner = null;
        while (el && hops < 8 && el !== document.body) {
          var txt = el.innerText || '';
          if (txt.length > 20 && CONSENT_WORDS.test(txt)) { banner = el; break; }
          el = el.parentElement; hops++;
        }
        if (!banner || seen.indexOf(banner) !== -1) continue;
        seen.push(banner);
        var st = window.getComputedStyle(banner);
        var fixedish = (st.position === 'fixed' || st.position === 'sticky' || parseInt(st.zIndex, 10) >= 500);
        if (!isReject && !fixedish) continue;      // accept-only needs a real consent UI
        var action = decideConsent(banner);
        note(action || 'kept', 'bar ' + (banner.id || banner.className || banner.tagName));
        if (action) { try { banner.remove(); } catch (e) {} unlockScroll(); }
      }

      // Consent bars with NO buttons at all: there is nothing to click, so take the
      // bar away instead — but only when its text is unmistakably about consent and
      // it is a pinned strip, never a form or a piece of page furniture.
      var nodes = document.body ? Array.prototype.slice.call(document.body.children) : [];
      var vw = window.innerWidth, vh = window.innerHeight;
      var COOKIE_WORD = /(cookie|consent|datenschutz|einwilligung|privatsph)/i;
      var ACTION_WORD = /(zustimm|akzeptier|ablehn|einstell|verwend|nutzen|tracking|gdpr|dsgvo|privacy)/i;
      for (var n = 0; n < nodes.length; n++) {
        var el2 = nodes[n];
        if (!el2 || !el2.isConnected || !isVisible(el2)) continue;
        var st2 = window.getComputedStyle(el2);
        if (st2.position !== 'fixed' && st2.position !== 'sticky') continue;
        var r2 = el2.getBoundingClientRect();
        var area2 = r2.width * r2.height;
        if (area2 < 0.02 * vw * vh || area2 > 0.6 * vw * vh) continue;
        if (el2.querySelector('input, select, textarea, form')) continue;   // not a form
        if (el2.querySelector(BUTTONS)) continue;                          // handled above
        var txt2 = (el2.innerText || '').replace(/\s+/g, ' ');
        if (txt2.length < 25 || txt2.length > 900) continue;
        if (!COOKIE_WORD.test(txt2) || !ACTION_WORD.test(txt2)) continue;
        note('removed', 'bar-nobuttons ' + (el2.id || el2.className || el2.tagName));
        try { el2.remove(); } catch (e) {}
        unlockScroll();
      }
    } catch (e) {}
  }

  // ── 5. Sweep + observe ────────────────────────────────────────────────────
  function sweep() {
    defuseFlags();
    unhideBait();
    patchBaitMeasure();
    plantBait();
    removeMatching(document);
    genericOverlaySweep();
    barSweep();
    removeAdblockWalls();
    deepConsentSweep();
    unlockScroll();
  }

  function onMutation() {
    try {
      removeMatching(document);
      genericOverlaySweep();
      barSweep();
      removeAdblockWalls();
      deepConsentSweep();
    } catch (e) {}
  }

  // Detectors run at document-start and again after load; be early and repeat.
  defuseFlags();
  unhideBait();
  patchBaitMeasure();
  plantBait();
  sweep();
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', function () { sweep(); }, false);
    window.addEventListener('load', function () { sweep(); }, false);
  }
  ['readystatechange', 'load'].forEach(function (ev) {
    try { document.addEventListener(ev, function () { defuseFlags(); sweep(); }, false); } catch (e) {}
  });

  // CMPs and walls inject late (1–8s); sweep a few times.
  [120, 300, 700, 1200, 2000, 3000, 5000, 8000].forEach(function (ms) {
    setTimeout(sweep, ms);
  });

  var observer = new MutationObserver(onMutation);
  function startObserver() {
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // SPA navigations
  try {
    ['yt-navigate-finish', 'yt-page-data-updated', 'turbo:load', 'pjax:end'].forEach(function (ev) {
      document.addEventListener(ev, function () { sweep(); }, false);
    });
    window.addEventListener('popstate', function () { setTimeout(sweep, 500); }, false);
  } catch (e) {}
})();

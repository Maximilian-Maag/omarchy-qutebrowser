// ==UserScript==
// @name         Google / Microsoft sign-in compatibility (Omarchy)
// @description  Makes the Google and Microsoft sign-in flows accept qutebrowser. config.py already sends a
//               real Chrome user agent to the sign-in hosts, but the "This browser or app
//               may not be secure" check also reads JavaScript detection signals that
//               QtWebEngine simply does not have: real Chrome exposes `window.chrome` and
//               `navigator.userAgentData`, an embedded Chromium exposes neither.
// @version      1.0
// @author       omarchy-qutebrowser
// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser
// @match        *://accounts.google.com/*
// @match        *://accounts.youtube.com/*
// @match        *://*.google.com/accounts/*
// @match        *://login.microsoftonline.com/*
// @match        *://login.live.com/*
// @match        *://login.microsoft.com/*
// @match        *://account.microsoft.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Must track the Chromium version the user agent advertises (config.py uses the real
  // QtWebEngine Chromium version, so the UA and these values stay consistent).
  var MAJOR = '140';
  var FULL = '140.0.7339.225';

  try {
    if (!window.chrome) { window.chrome = {}; }
    var ch = window.chrome;
    if (!ch.runtime) { ch.runtime = {}; }
    if (!ch.loadTimes) { ch.loadTimes = function () { return {}; }; }
    if (!ch.csi) { ch.csi = function () { return {}; }; }
  } catch (e) { /* a page that forbids this is not worth breaking */ }

  try {
    if (!navigator.userAgentData) {
      var brands = [{ brand: 'Chromium', version: MAJOR },
                    { brand: 'Google Chrome', version: MAJOR },
                    { brand: 'Not?A_Brand', version: '24' }];
      navigator.userAgentData = {
        brands: brands, mobile: false, platform: 'Linux',
        getHighEntropyValues: function () {
          return Promise.resolve({ architecture: 'x86', bitness: '64', brands: brands,
            mobile: false, model: '', platform: 'Linux', platformVersion: '6.0.0',
            uaFullVersion: FULL });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: 'Linux' }; }
      };
    }
  } catch (e) { /* best effort */ }

  // ── deleting WebAuthn: still right for Microsoft, harmful on Google ───────
  // Deleting the API makes a sign-in page offer its PASSWORD flow rather than a passkey
  // ceremony QtWebEngine cannot serve. But QtWebEngine ALREADY answers
  // isUserVerifyingPlatformAuthenticatorAvailable() === false natively (measured), so the page
  // offers its password anyway — and on Google the deletion is actively harmful: it leaves a
  // browser advertising Chrome/140 with NO PublicKeyCredential at all, which no real Chrome
  // ever has. Google answers a browser that tampered with its own WebAuthn surface with
  // "This browser or app may not be secure" — i.e. the shim can cost the very sign-in it exists
  // to protect. So: delete on the Microsoft hosts (where the passkey broker is allowed to
  // install and would otherwise take the page over), leave Google's native API intact (the
  // broker is kept out of google.com, see the broker's per-site policy).
  function isGoogleHost() {
    try {
      var h = String((location && location.hostname) || '').toLowerCase();
      return h === 'google.com' || /(^|\.)google\.com$/.test(h)
             || /(^|\.)youtube\.com$/.test(h);
    } catch (e) { return false; }
  }

  try {
    if (!isGoogleHost()) {
      if (window.PublicKeyCredential) {
        Object.defineProperty(window, 'PublicKeyCredential',
          { value: undefined, configurable: true });
      }
      if (navigator.credentials) {
        Object.defineProperty(navigator.credentials, 'get',
          { value: undefined, configurable: true });
        Object.defineProperty(navigator.credentials, 'create',
          { value: undefined, configurable: true });
      }
    }
  } catch (e) { /* best effort */ }

  try {
    if (navigator.webdriver) {
      Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
    }
  } catch (e) { /* best effort */ }
})();

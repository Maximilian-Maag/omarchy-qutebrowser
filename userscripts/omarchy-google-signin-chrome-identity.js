// ==UserScript==
// @name        Google sign-in: Chrome identity tells
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description Makes Google's sign-in accept this browser. Verified: with it, Google passes the
//              identifier step and offers the passkey; without it, the submit is refused
//              ('Couldn't sign you in - This browser or app may not be secure'). It is a
//              deliberate, host-scoped exception to the repository's API-rewrite ban, held to
//              Google hosts only by tests/test_regression_signin_untouched.py.
//
//              Why this shape, given the shim failed: google-signin-compat.js redefined
//              navigator.userAgentData as an OWN property on the navigator instance (real Chrome
//              keeps it on Navigator.prototype), and deleted PublicKeyCredential on Microsoft
//              hosts. Both read as tampering. This does neither - it patches the prototype getter
//              and wraps the engine's own values, deletes nothing, and touches no WebAuthn API.
//
//              Kept minimal on purpose: only the three tells below, prototype-level, nothing
//              deleted, no WebAuthn API touched. Widening it risks the refusal coming back - the
//              retired google-signin-compat.js shim rewrote far more and got the browser refused.
//
// @match       https://accounts.google.com/*
// @run-at      document-start
// ==/UserScript==
(function () {
    'use strict';
    try {
        // navigator.userAgentData.brands says Chromium only; Chrome says "Google Chrome".
        // Patch the PROTOTYPE getter - an own property on `navigator` is itself the tell.
        var navProto = Object.getPrototypeOf(navigator);
        var uadDesc = Object.getOwnPropertyDescriptor(navProto, 'userAgentData');
        if (uadDesc && typeof uadDesc.get === 'function') {
            var nativeGet = uadDesc.get;
            Object.defineProperty(navProto, 'userAgentData', {
                configurable: true,
                enumerable: uadDesc.enumerable,
                get: function () {
                    var real = nativeGet.call(this);
                    if (!real || !real.brands) { return real; }
                    var source = Array.prototype.map.call(real.brands, function (b) {
                        return { brand: b.brand, version: b.version };
                    });
                    // Rebuild the list the way Chrome orders it, and give "Google Chrome" the
                    // engine's real major version. Two things QtWebEngine gets wrong here, both
                    // measured on the live engine (brands = ["Not=A?Brand 24", "Chromium 140"]):
                    //  - the GREASE brand is listed FIRST; Chrome keeps it last, and the
                    //    sec-ch-ua header this config sends already puts it last, so the JS should
                    //    agree with the header;
                    //  - taking the version from brands[0] stamps "Google Chrome" with the grease
                    //    version ("24") instead of the engine's major ("140") — a self-inflicted
                    //    mismatch. Use the "Chromium" brand's version.
                    var chromium = null;
                    var grease = [];
                    var rest = [];
                    source.forEach(function (b) {
                        if (b.brand === 'Google Chrome') { return; }               // drop duplicates
                        if (/^Not.?A.?Brand$/i.test(b.brand)) { grease.push(b); return; }
                        if (b.brand === 'Chromium') { chromium = b; }
                        rest.push(b);
                    });
                    if (source.length) {
                        var major = (chromium && chromium.version) ||
                                    (source[0] && source[0].version) || '';
                        source = [{ brand: 'Google Chrome', version: major }].concat(rest, grease);
                    }
                    var brands = source;
                    return Object.create(Object.getPrototypeOf(real), {
                        brands: { value: brands, enumerable: true, configurable: true },
                        mobile: { value: real.mobile, enumerable: true, configurable: true },
                        platform: { value: real.platform, enumerable: true, configurable: true }
                    });
                }
            });
        }

        // window.chrome is empty in this engine; real Chrome exposes these members.
        if (!window.chrome) { window.chrome = {}; }
        if (!window.chrome.app) { window.chrome.app = {}; }
        if (!window.chrome.runtime) { window.chrome.runtime = {}; }
        if (typeof window.chrome.csi !== 'function') {
            window.chrome.csi = function () { return {}; };
        }
        if (typeof window.chrome.loadTimes !== 'function') {
            window.chrome.loadTimes = function () { return {}; };
        }

        // pdfViewerEnabled reports false; a desktop Chrome with a PDF viewer reports true.
        var navPdfDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),
                                                         'pdfViewerEnabled');
        if (navPdfDesc && typeof navPdfDesc.get === 'function') {
            Object.defineProperty(Object.getPrototypeOf(navigator), 'pdfViewerEnabled', {
                configurable: true,
                enumerable: navPdfDesc.enumerable,
                get: function () { return true; }
            });
        }
    } catch (e) { /* never break the page */ }
})();

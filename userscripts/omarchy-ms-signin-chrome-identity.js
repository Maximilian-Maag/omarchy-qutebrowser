// ==UserScript==
// @name        Microsoft sign-in: Chrome identity tells
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description The JavaScript half of the stock-Chrome identity on the Microsoft sign-in hosts.
//              The request half (config/config.py `_STOCK_CHROME_HOSTS`) has always sent these
//              hosts a `sec-ch-ua` that says "Google Chrome", while this half was missing - so the
//              header claimed Chrome and navigator.userAgentData.brands answered Chromium-only, the
//              header and the page disagreeing about what browser this is. Measured drift: 12 hosts
//              in the request half, 7 in the JavaScript half. This closes the Microsoft four.
//
//              The shape is the one verified on Google (omarchy-google-signin-chrome-identity.js),
//              copied deliberately rather than reinvented: patch the PROTOTYPE getter and wrap the
//              engine's own values, build "Google Chrome" with the engine's real major, delete
//              nothing, touch no WebAuthn API. The retired google-signin-compat.js shim did the
//              opposite (an own property on `navigator`, deletions, PublicKeyCredential surgery)
//              and got the browser refused as tampered.
//
//              Kept to the two/three tells below and to Microsoft hosts only, held to both by
//              tests/test_regression_signin_untouched.py. No WebAuthn API is touched here: the
//              platform-authenticator correction is a separate, deliberately separate script
//              (omarchy-ms-passkey-platform-probe.js).
//
// @match       https://login.microsoftonline.com/*
// @match       https://login.live.com/*
// @match       https://login.microsoft.com/*
// @match       https://account.microsoft.com/*
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

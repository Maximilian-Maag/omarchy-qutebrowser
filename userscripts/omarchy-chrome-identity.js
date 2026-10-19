// ==UserScript==
// @name        Stock Chrome identity for bot-managed sites
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description Makes sites behind managed bot-detection (LinkedIn/Cloudflare, Kleinanzeigen
//              and immowelt/DataDome) stop treating this browser as automated. The engine
//              differs from Chrome in a few JavaScript tells — navigator.userAgentData.brands
//              says "Chromium" only, window.chrome is empty, pdfViewerEnabled is false — and a
//              detection suite reads those, plus the request-level tells config.py already
//              corrects, as a fake or tampered browser. This corrects the JavaScript half.
//              Measured: qutebrowser's engine reports brands ["Not=A?Brand","Chromium"], an
//              empty window.chrome, and pdfViewerEnabled false; the request half (UA without
//              the QtWebEngine token, agreeing client hints, readable canvas, no DNT) is set
//              per-host in config/config.py for the same hosts.
//
//              A deliberate, host-scoped exception to the repository's API-rewrite ban, held to
//              LinkedIn / Kleinanzeigen / immowelt by tests/test_regression_signin_untouched.py
//              and mirrored by tests/js/chrome-identity.test.js.
//
//              Why this shape, given the shim that failed: google-signin-compat.js redefined
//              navigator.userAgentData as an OWN property on the navigator instance (real Chrome
//              keeps it on Navigator.prototype) and deleted PublicKeyCredential. Both read as
//              tampering. This does neither — it patches the prototype getter and wraps the
//              engine's own values, deletes nothing, and touches no WebAuthn API.
//
//              Kept minimal on purpose: only the same three tells the Google sign-in script
//              corrects, nothing deleted, no WebAuthn API touched. navigator.plugins is left
//              alone: a hand-built PluginArray is itself a tell, and a wrong one is worse than
//              an empty one.
// @match       https://www.linkedin.com/*
// @match       https://*.linkedin.com/*
// @match       https://www.kleinanzeigen.de/*
// @match       https://*.kleinanzeigen.de/*
// @match       https://www.immowelt.de/*
// @match       https://*.immowelt.de/*
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

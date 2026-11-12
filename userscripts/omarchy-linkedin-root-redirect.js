// ==UserScript==
// @name        LinkedIn: leave Cloudflare's block page for the login page
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description LinkedIn's Cloudflare hard block is PATH-scoped, and the bare root URL is the
//              tripwire: measured here, https://www.linkedin.com/ is answered with Cloudflare's
//              "Sorry, you have been blocked" (1020-style, Ray ID in the page) while
//              https://www.linkedin.com/login, /feed/ and /jobs/ load normally in the SAME engine,
//              on the SAME address, in a fresh profile. Nothing in config.py or the stock-Chrome
//              identity changes that verdict (a bare engine is served the block too, and so is one
//              with the Chrome client hints applied), so the way in is the login page rather than
//              the front door.
//
//              This script does one thing: when the document IS that block page and we are not
//              already on the login path, it navigates to https://www.linkedin.com/login/. On any
//              real LinkedIn page it does nothing at all - the root URL serves the feed normally
//              once a session exists, and that must not be redirected.
//
//              No browser API is touched (see tests/test_regression_signin_untouched.py): the
//              script only reads document.title / document.body and calls location.replace with a
//              hard-coded LinkedIn URL. Held to www.linkedin.com by tests/js/linkedin-redirect.test.js
//              and the regression guard.
// @match       https://www.linkedin.com/*
// @run-at      document-start
// ==/UserScript==
(function () {
    'use strict';

    // The login path, absolute so location.replace cannot be redirected relative.
    var LOGIN_URL = 'https://www.linkedin.com/login/';
    var LOGIN_PATH = '/login';

    // Cloudflare's hard block, matched on either marker independently: the title
    // ("Attention Required! | Cloudflare") and the body ("Sorry, you have been blocked") are two
    // separate tells, and the block page carries both. Reading both means a reworded page still
    // counts as blocked as long as one of them survives.
    function isBlockPage() {
        var title = document.title || '';
        var body = document.body;
        var text = body ? (body.textContent || '') : '';
        return /attention required/i.test(title) || /you have been blocked/i.test(text);
    }

    // True for /login and /login/ - the destination itself, so a block page served ON the login
    // path cannot bounce to the same URL forever.
    function isLoginPath(path) {
        return path.indexOf(LOGIN_PATH) === 0;
    }

    function leaveBlockPage() {
        try {
            if (isBlockPage() && !isLoginPath(location.pathname)) {
                location.replace(LOGIN_URL);
            }
        } catch (e) { /* never break the page */ }
    }

    // A DocumentReady injection point would be enough for the block page (its body is complete
    // before any script runs), but document-start plus these two hooks also covers a page that is
    // rewritten later - and an already-parsed document, which is what a restart-restored tab is.
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        leaveBlockPage();
    }
    document.addEventListener('DOMContentLoaded', leaveBlockPage);
    window.addEventListener('load', leaveBlockPage);
})();

// ==UserScript==
// @name        Microsoft passkey: report a platform authenticator
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description QtWebEngine reports isUserVerifyingPlatformAuthenticatorAvailable() as false, so
//              Microsoft's passkey page concludes there is no passkey capability and never starts a
//              ceremony - it spins on "Verifying..." forever. Correcting that one answer makes the
//              passkey sign-in work end to end (engine -> YubiKey -> PIN -> touch -> signed in).
//
//              The correction is RETRIED, because it cannot be applied in one shot: the engine
//              installs PublicKeyCredential at its own pace, so a single document-start attempt
//              loses the race on many loads. Measured: the passkey prompt appeared on one load and
//              then stopped appearing on the next, with the identical uscript - a coin toss, not a
//              working fix. `patch()` is idempotent and runs until it lands, then stops.
//
//              DELIBERATELY NOT APPLIED TO GOOGLE. Measured: Google refuses the sign-in outright
//              ("Couldn't sign you in / This browser or app may not be secure") for even this
//              narrow a deviation - only the one probe, via a Proxy over the engine's own method.
//              Google sign-in therefore uses a separate, Google-only script and the password path.
// @match       https://login.microsoft.com/*
// @match       https://login.live.com/*
// @match       https://fpt.live.com/*
// @match       https://account.microsoft.com/*
// @match       https://login.microsoftonline.com/*
// @run-at      document-start
// ==/UserScript==
(function () {
    'use strict';
    var NAME = 'isUserVerifyingPlatformAuthenticatorAvailable';
    var patched = false;

    function patch() {
        if (patched) { return true; }
        try {
            var PKC = window.PublicKeyCredential;
            if (!PKC) { return false; }
            var desc = Object.getOwnPropertyDescriptor(PKC, NAME);
            if (!desc || typeof desc.value !== 'function') { return false; }
            Object.defineProperty(PKC, NAME, {
                configurable: true,
                enumerable: desc.enumerable,
                writable: desc.writable,
                value: new Proxy(desc.value, {
                    apply: function () { return Promise.resolve(true); }
                })
            });
            patched = true;
            return true;
        } catch (e) {
            return false;                       // never break the page
        }
    }

    if (patch()) { return; }

    // Retry until the engine's API shows up (roughly 10 seconds), and once more when the DOM is
    // ready. Warn rather than fail silently: a silent no-op here is what made this look flaky.
    var tries = 0;
    var timer = setInterval(function () {
        if (patch()) { clearInterval(timer); return; }
        if (++tries >= 200) {
            clearInterval(timer);
            try {
                console.warn('omarchy: could not correct ' + NAME
                             + ' - the Microsoft passkey prompt may not appear');
            } catch (e) { /* nothing to do */ }
        }
    }, 50);
    try {
        document.addEventListener('DOMContentLoaded', function () {
            if (patch()) { clearInterval(timer); }
        });
    } catch (e) { /* nothing to do */ }
})();

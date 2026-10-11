// ==UserScript==
// @name        Microsoft passkey: report a platform authenticator
// @namespace   Maximilian-Maag.omarchy-qutebrowser
// @description QtWebEngine reports isUserVerifyingPlatformAuthenticatorAvailable() as false, so
//              Microsoft's passkey page concludes there is no passkey capability and never starts a
//              ceremony - it just spins on "Verifying...". Measured: correcting that one answer
//              makes Microsoft's passkey sign-in work end to end (engine -> YubiKey -> PIN -> touch
//              -> signed in).
//
//              DELIBERATELY NOT APPLIED TO GOOGLE. Measured: Google refuses the sign-in outright
//              ("Couldn't sign you in / This browser or app may not be secure") with even this
//              narrow a deviation - only the one probe, via a Proxy over the engine's own method.
//              Google sign-in therefore stays on the password path, and Microsoft gets passkeys.
// @match       https://login.microsoft.com/*
// @match       https://login.live.com/*
// @match       https://fpt.live.com/*
// @match       https://account.microsoft.com/*
// @match       https://login.microsoftonline.com/*
// @run-at      document-start
// ==/UserScript==
(function () {
    'use strict';
    try {
        var PKC = window.PublicKeyCredential;
        if (!PKC) { return; }
        var name = 'isUserVerifyingPlatformAuthenticatorAvailable';
        var desc = Object.getOwnPropertyDescriptor(PKC, name);
        if (!desc || typeof desc.value !== 'function') { return; }
        Object.defineProperty(PKC, name, {
            configurable: true,
            enumerable: desc.enumerable,
            writable: desc.writable,
            value: new Proxy(desc.value, {
                apply: function (target, thisArg, args) { return Promise.resolve(true); }
            })
        });
    } catch (e) { /* never break the page */ }
})();

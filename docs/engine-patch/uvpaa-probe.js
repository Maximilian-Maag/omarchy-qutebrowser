// Report the capability answer a page receives, and whether our correction is in effect.
// Usage:  :jseval --world=main -f docs/engine-patch/uvpaa-probe.js
(function () {
    var PKC = window.PublicKeyCredential;
    var desc = PKC ? Object.getOwnPropertyDescriptor(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable') : null;
    console.log('UVPAA_PROBE=' + JSON.stringify({
        url: location.href.slice(0, 90),
        hasPublicKeyCredential: !!PKC,
        hasMethod: !!(desc && typeof desc.value === 'function')
    }));
    if (PKC && desc && typeof desc.value === 'function') {
        PKC.isUserVerifyingPlatformAuthenticatorAvailable()
            .then(function (v) { console.log('UVPAA=' + v); });
    }
    if (PKC && PKC.isConditionalMediationAvailable) {
        PKC.isConditionalMediationAvailable()
            .then(function (v) { console.log('CONDITIONAL_MEDIATION=' + v); });
    }
})();

# Passkey sign-in in qutebrowser (WebAuthn / FIDO2)

Why signing in with a security key needed work at all, what the actual causes turned out to be,
and how each one is addressed. Everything here is measured, not inferred — the log excerpts are real.

The short version: **QtWebEngine tells every page there is no platform authenticator.** Linux has
none (a YubiKey is a *cross-platform* authenticator, not a platform one), so the answer is
technically true and practically fatal: a relying party reads it as "this browser cannot do
passkeys" and never starts a ceremony. The page sits on "Signing in with your passkey..." forever.

## What works today

| provider | state | mechanism |
|---|---|---|
| Microsoft | works, but required the platform-probe userscript | `userscripts/omarchy-ms-passkey-platform-probe.js` |
| Google | account sign-in is refused on browser identity grounds | `userscripts/omarchy-google-signin-chrome-identity.js` gets past the identifier step only |
| engine | a patched build removes the need for the Microsoft userscript | `docs/engine-patch/` |

The engine *does* drive a FIDO2 key correctly — this is measured, not assumed. Given a page that
actually calls WebAuthn, a complete ceremony runs:

```
WebAuthn UX request for rp='google.com'
WebAuthn UX state: CollectPin              <- the key's PIN
WebAuthn UX state: FinishTokenCollection   <- "Touch your security key to sign in to google.com"
WebAuthn UX state: Completed               <- signed in
```

So the work was never about the key, the driver, or the ceremony. It was about **one boolean**, and
about *when* it can be corrected.

## Cause 1 — the capability answer

`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` returns `false`.

A page uses it as a gate: if no platform authenticator is available, offer the password instead of
the passkey. Microsoft's consumer passkey flow takes that branch and parks on a spinner with no
button to press. Measured on Microsoft's bridge page, with the userscript provably injected:

```
BRIDGE_PROBE={"url":"https://login.microsoft.com/.../bridge/fido","top":true,"frames":0}
BRIDGE_UVPA=false        <- the correction is not in effect
BRIDGE_COND=true         <- conditional/autofill mediation IS reported available
```

Correcting that single answer is enough for Microsoft. The correction wraps the engine's *own*
method in a `Proxy` — nothing is removed or replaced, only the return value changes — and is scoped
to Microsoft's hosts.

**It is deliberately not applied to Google's account hosts.** Measured: Google refuses the sign-in
outright ("Couldn't sign you in — This browser or app may not be secure") for even that narrow a
deviation. Google therefore needs browser *identity* correction as well, which is a different and
much larger problem; see "Known limits".

## Cause 2 — the correction is a race, not a one-shot

`PublicKeyCredential`, and the method on it, appear **after** `document-start`. A userscript that
reads the method once and gives up if it is not there yet lands on some page loads and silently does
nothing on others. This is the whole explanation for the symptom that cost the most time:

> the passkey prompt appeared once, and on the next login it did not — with an identical script

Measured directly: after a load where the prompt had worked, the very next load reported
`NOW_UVPA=false` with the script demonstrably installed. It was never reliable; it won a race.

The probe therefore retries until the API appears (every 50 ms, at most 200 tries), stops once it has
landed, and **warns instead of failing silently** when it cannot:

```js
var timer = setInterval(function () {
    attempts += 1;
    if (patch()) { everLanded = true; return; }
    if (!everLanded && attempts >= 200) {
        clearInterval(timer);
        console.warn('omarchy: could not correct ' + NAME + ' - the passkey prompt may not appear');
    }
}, 50);
```

A silent no-op is what made this look like flakiness rather than a bug. `tests/js/ms-passkey-probe.test.js`
carries a test named `THE RACE` that reproduces the exact symptom.

## Cause 3 — the engine may replace the object, not just the property

A `patched` flag set on first success is a lie: the engine can install its real implementation
afterwards and overwrite the correction, and a flag that stops the script looking will never notice.
Any further work here should verify the correction is *still in place* (a marker on our own wrapper),
not that it once succeeded.

## Cause 4 — a conditional request hangs forever

A relying party may call `navigator.credentials.get({mediation: "conditional"})` to have the passkey
*suggested* inline as the user types, rather than shown as a modal prompt. Chromium marks that
presentation `kAutofill`, and QtWebEngine shows nothing for `kAutofill` — the autofill UI is supposed
to belong to an autofill component Qt does not have:

```cpp
// authenticator_request_dialog_controller.cpp, before the patch
if (m_uiPresentation == UIPresentation::kAutofill)
    return;                       // no dialog, ever
```

A conditional request **never times out** by design, so the page waits forever with nothing
clickable. This is a *different* cause from the capability answer, but the symptom on screen is the
same spinner — which is why the two were conflated for a while. There is a second suppression of the
same kind in the account-selection path, which is why the fix is applied at the entry point
(`SetUIPresentation`) so the presentation never becomes `kAutofill` at all. See
`docs/engine-patch/README.md`, "Patch 2".

## The proper fix — patch the engine

Two patches, both confined to Qt's own delegate files, no Chromium file touched:

1. **The capability answer** — `WebAuthenticationDelegateQt` reports a platform authenticator as
   available.
2. **The conditional-request hang** — `AuthenticatorRequestClientDelegateQt::SetUIPresentation`
   presents a `kAutofill` request as `kModal` (Cause 4, above).

For (1), Chromium already routes this answer through the embedder:

```
content/public/browser/web_authentication_delegate.h:
    virtual void IsUserVerifyingPlatformAuthenticatorAvailableOverride(
        RenderFrameHost* render_frame_host,
        base::OnceCallback<void(std::optional<bool>)> callback);

content/browser/webauth/authenticator_common_impl.cc:
    GetWebAuthenticationDelegate()
        ->IsUserVerifyingPlatformAuthenticatorAvailableOverride( ... );   // 4 call sites
```

QtWebEngine subclasses that delegate (`WebAuthenticationDelegateQt`, in
`src/core/authenticator_request_client_delegate_qt.{h,cpp}`) and overrides only `SupportsResidentKeys`.
The patch adds one override that answers `true`:

```cpp
void WebAuthenticationDelegateQt::IsUserVerifyingPlatformAuthenticatorAvailableOverride(
        content::RenderFrameHost *render_frame_host,
        base::OnceCallback<void(std::optional<bool>)> callback)
{
    Q_UNUSED(render_frame_host);
    std::move(callback).Run(true);
}
```

Nothing is bypassed: the security key still performs the user verification (PIN and touch). The page
is simply not told to give up. Because it is in the engine, it is **not detectable by the page**,
which is why it is the right fix and the userscript is only a stopgap — a userscript is a
page-visible deviation, and that is exactly what Google punishes.

See `docs/engine-patch/README.md` for the build.

## Implementation gap analysis

Beyond the two fixes above, the natural question is "what else did Qt not wire up?" — and the answer
is best measured against Chromium's interfaces rather than guessed. These commands re-derive the
picture from the engine source, so it can be re-checked after a Qt upgrade:

```bash
SRC=~/Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src
CH=$SRC/3rdparty/chromium

# WebAuthn request delegate: Chromium's virtuals vs what Qt overrides
grep -oE '[A-Za-z]+\(' "$CH/content/public/browser/authenticator_request_client_delegate.h" \
  | tr -d '(' | sort -u > /tmp/ch.txt
grep -oE '[A-Za-z]+' "$SRC/core/authenticator_request_client_delegate_qt.h" | sort -u > /tmp/qt.txt
comm -23 /tmp/ch.txt /tmp/qt.txt

# The WebAuthenticationDelegate (patch 1's class)
grep -oE 'virtual [^;(]*[A-Za-z]+\(' "$CH/content/public/browser/web_authentication_delegate.h" \
  | grep -oE '[A-Za-z]+\($' | tr -d '(' | sort -u > /tmp/ch2.txt
comm -23 /tmp/ch2.txt /tmp/qt.txt

# Explicit not-implemented markers anywhere in Qt's core
grep -rn 'NOTIMPLEMENTED' "$SRC/core/"*.cpp
```

The result, and the honest triage:

| candidate | verdict |
|---|---|
| capability answer (`IsUserVerifyingPlatformAuthenticatorAvailableOverride`) | **fixed** — patch 1 |
| conditional/autofill passkey UI (`kAutofill`) | **fixed (hang removed)** — patch 2; a real dropdown is still not implemented |
| `SignalAllAcceptedCredentials`, `UpdateUserPasskeys`, `PasskeyUnrecognized` | **correct as-is** — they act on a passkey *store* Qt has none of; the no-op default is right, and implementing them would be faking a feature |
| `MaybeGetRequestProxy`, `MaybeGetRelyingPartyIdOverride`, `ShouldPermitIndividualAttestation`, `BrowserProvidedPasskeysAvailable` | **correct as-is** — no proxy/cloud authenticator is configured; `BrowserProvidedPasskeysAvailable` returning false is truthful (Qt has no cloud keychain) |
| `RenderWidgetHostViewQt::EnsureSurfaceSynchronizedForWebTest()` | **test-only** — not shipped behaviour |
| Vulkan `NOTIMPLEMENTED()` (`chromium_overrides.cpp`) | **unreachable on Linux** — inside `#if BUILDFLAG(IS_APPLE)` (MoltenVK) |
| `MessagePumpForUIQt::Run()` / `Quit()` | **not in normal use** — Qt's own comment: only when the pump runs outside the GUI thread |
| `ClipboardQt::ReadBookmark()` | real but minor (X11 selection bookmark) |
| `AutofillClientQt::GetAutofillSuggestions()` | **correct as-is** — Qt's comment: "Called by password_manager component only"; with KeePassXC the empty return is right |

So of the apparent gaps, exactly one was real and user-visible (the conditional-request hang); most
of the rest are interfaces where Qt's default is the *correct* answer, and "closing" them would mean
introducing bugs by un-correcting a correct default.

## Verifying

Watch the engine's own view while attempting a sign-in:

```
journalctl --user -u <qutebrowser-unit> -f | grep -iE "WebAuthn UX|FIDO:|CTAP"
```

A working ceremony shows `WebAuthn UX request for rp='...'` followed by `CollectPin`,
`FinishTokenCollection`, `Completed`. **No `WebAuthn UX request` line at all** means the page never
asked — which is Cause 1 or 2, never the key.

To see the capability answer the page gets, on the page itself:

```
:jseval --world=main -f docs/engine-patch/uvpaa-probe.js
```

`UVPAA=false` on a page where the probe is loaded means the correction did not land.

## Pitfalls learned the hard way

- **Two greasemonkey directories** exist (`~/.local/share/qutebrowser/greasemonkey/` and
  `~/.config/qutebrowser/greasemonkey/`). A script in the wrong one, or a stale copy in the other,
  silently wins. Keep exactly one, symlinked into the repository.
- **A restored tab from a previous session is dead.** A page that was mid-ceremony cannot recover
  and can hold a pending request that blocks later ones. Restart without restoring the session.
- **A restart can load a stale script list.** An instance that scanned greasemonkey *before* a script
  was installed will never run it, however many times the page reloads. Restart the browser.
- **Never let the KeePassXC auto-fill run on a passkey frame.** It injects a payload and synthesises
  a submit click; on a passkey page that breaks the ceremony. `userscripts/qute-keepassxc-fill`
  declines on `bridge/fido`, `/webauthn` and `/signin/challenge/pk`, and never presses submit on a
  sign-in provider.
- **Do not "fix" the flakiness with a flag.** See Cause 3.

## Known limits

- **Google still refuses account sign-in.** It rejects the browser's identity — the engine reports
  Chromium-only `userAgentData.brands`, an empty `window.chrome`, and `pdfViewerEnabled: false`.
  Correcting those does get past the identifier step, but it is a large page-visible deviation and
  Google is entitled to refuse it. The honest position: Google cannot be signed in from this engine
  without impersonating Chrome, which is not something to ship.
- **The Microsoft fix above the engine is a userscript**, so it is page-visible and could stop
  working if Microsoft's checks change. The engine patch removes that dependency.
- **Microsoft's flow is intermittent even so.** Its passkey page does not always call WebAuthn; the
  log distinguishes "the page never asked" from "the browser failed".

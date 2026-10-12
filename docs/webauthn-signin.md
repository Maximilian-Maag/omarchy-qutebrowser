# Passkey sign-in in qutebrowser (WebAuthn / FIDO2)

Why signing in with a security key needed work at all, what the actual causes turned out to be,
and how each one is addressed. Everything here is measured, not inferred — the log excerpts are real.

The short version: **QtWebEngine tells every page there is no platform authenticator.** Linux has
none (a YubiKey is a *cross-platform* authenticator, not a platform one), so the answer is
technically true and practically fatal: a relying party reads it as "this browser cannot do
passkeys" and never starts a ceremony. The page sits on "Signing in with your passkey..." forever.

## What works today

Verified 2026-10-12 with the patched engine (`qt6-webengine` 6.11.2-2) installed:

| provider | state | mechanism |
|---|---|---|
| Microsoft | **works natively** | engine patch 1 — the platform-probe userscript is no longer needed and is now *disabled*, and sign-in still prompts for the key |
| Google | **signs in**, but **only** with the identity userscript | engine patch 1 **and** `userscripts/omarchy-google-signin-chrome-identity.js`. Tested: disabling that userscript (engine patch alone) → Google refuses, "This browser or app may not be secure" |
| engine | patched build installed; supersedes the Microsoft userscript | `docs/engine-patch/` |

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

**For Google the engine patch is necessary but not sufficient.** An engine-level `true` is not
detectable by the page (measured: the same probe answers `true` natively, with no script), and that
is enough for Microsoft. Google additionally requires the browser's *identity* to be corrected — the
page-visible `userscripts/omarchy-google-signin-chrome-identity.js`. Tested both ways: with the
engine patch *and* that userscript, Google signs in; with the engine patch alone (userscript
disabled), Google refuses with "This browser or app may not be secure". See "What works today" and
"Known limits".

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

Beyond the two fixes above, the natural question is "what else did Qt not wire up?" — the complete,
triaged answer (every WebAuthn interface and every `NOTIMPLEMENTED` in Qt's own sources, each marked
closed / accepted / not-feasible) lives in [`implementation-gaps.md`](implementation-gaps.md). These
commands re-derive the picture from the engine source, so it can be re-checked after a Qt upgrade:

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

## Verified on this machine (2026-10-12)

`qt6-webengine` 6.11.2-2 (both patches) was installed and tested.

**Patch 1, mechanically** — ask the installed engine the capability question directly, with no
userscript and no page involved: load a secure origin and evaluate
`isUserVerifyingPlatformAuthenticatorAvailable()`. The same probe against two libraries:

| library | answer |
|---|---|
| the backed-up unpatched 6.11.2-1 (`LD_LIBRARY_PATH=…/rollback`) | `false` |
| the installed patched library | `true` |

(`ldd` confirmed the control actually loaded the unpatched `.so`, and the installed library's sha256
was checked against the one built into the package — they match.)

**End to end, by hand** — with the Microsoft platform-probe userscript *disabled*, and nothing else
injecting the WebAuthn API: Microsoft's passkey sign-in prompts for the key and completes. That is
the engine doing the work, with no page-visible correction.

**Google, isolated** — the open question was whether Google still needs the chrome-identity
userscript. Tested by disabling it, leaving the engine patch as the only active correction: Google
refuses, "This browser or app may not be secure". Re-enabling it restores sign-in. So for Google the
engine patch is *necessary but not sufficient*; the identity userscript is still required, and is
kept enabled.

## Verifying

Watch the engine's own view while attempting a sign-in:

```
journalctl --user -u <qutebrowser-unit> -f | grep -iE "WebAuthn UX|FIDO:|CTAP"
```

**Caveat:** a qutebrowser launched through `uwsm-app` (the Omarchy/Hyprland launcher) has its
stdout/stderr pointed at `/dev/null`, so the journal carries *no* engine lines from it. Launch from
a terminal, or enable the WebAuthn logging category, when you actually need the log.

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

- **Google requires the chrome-identity userscript — measured, not assumed.** With the engine patch
  *and* `userscripts/omarchy-google-signin-chrome-identity.js`, Google signs in. With that userscript
  disabled (engine patch alone), Google refuses: "This browser or app may not be secure". So the
  userscript is still required and is kept enabled. It is a large page-visible deviation, which is a
  real cost worth removing if Google's checks ever allow it — but not at the price of breaking
  sign-in.
- **The Microsoft fix is no longer a userscript.** The engine patch replaced it, and it was verified
  sign-in with the userscript disabled. The userscript is retained only as a fallback.
- **Microsoft's flow is intermittent even so.** Its passkey page does not always call WebAuthn; the
  log distinguishes "the page never asked" from "the browser failed".

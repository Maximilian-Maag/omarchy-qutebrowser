# Implementation gaps — the complete register

Every gap found between QtWebEngine / qutebrowser and a correct passkey experience, with its
status. "Closed" means fixed in this repository (or by the patch in `docs/engine-patch/`);
"accepted" means it is *correct as it stands* or cosmetically different but functionally
equivalent; "not feasible" means it is a Chromium subsystem, not a plugin gap. Nothing here is
left as an unexamined "maybe" — that is the point of writing it down.

Re-derive the interface picture from the source at any time (so it survives a Qt upgrade):

```bash
SRC=~/Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src
CH=$SRC/3rdparty/chromium
# WebAuthn request-delegate virtuals Chromium defines vs what Qt overrides
grep -oE '[A-Za-z]+\(' "$CH/content/public/browser/authenticator_request_client_delegate.h" \
  | tr -d '(' | sort -u > /tmp/ch.txt
grep -oE '[A-Za-z]+' "$SRC/core/authenticator_request_client_delegate_qt.h" | sort -u > /tmp/qt.txt
comm -23 /tmp/ch.txt /tmp/qt.txt
# every NOTIMPLEMENTED in Qt's own sources
grep -rn 'NOTIMPLEMENTED()' "$SRC" --include=*.cpp | grep -v /3rdparty/
```

## Engine (QtWebEngine)

| gap | status | detail |
|---|---|---|
| `isUserVerifyingPlatformAuthenticatorAvailable()` returns `false` | **closed** — engine patch 1 | pages concluded "no passkeys" and never started a ceremony. `WebAuthenticationDelegateQt` now answers `true`. |
| a `mediation:"conditional"` request hangs forever | **closed** — engine patch 2 | `kAutofill` presentation showed nothing and never timed out. `SetUIPresentation` now presents it as `kModal`, so the user gets the chooser. |
| a real inline autofill passkey dropdown | **closed (plugin-side)** | the blocking `QInputDialog` chooser is replaced by a **non-modal, keyboard-driven suggestion list** anchored to the focused field (`_AccountPopup`), styled from the applied Omarchy theme. Because patch 2 already delivers the request to the plugin and the plugin owns the page/view, this needed **no engine change** — so no rebuild. Anchoring asks the page for `document.activeElement.getBoundingClientRect()` and scales it into view pixels; a field the page cannot report leaves the list at the view corner. See [`engine-patch/conditional-autofill-plan.md`](engine-patch/conditional-autofill-plan.md). |
| hybrid / caBLE ("use the passkey on your phone", QR) | **not feasible here** | `MaybeGetRequestProxy` is unimplemented. caBLE is a Chromium subsystem (BLE tunnel, QR rendezvous, tunnel server) — reimplementing it is a project in its own right, not a plugin gap. A security key works without it. |
| platform-authenticator discovery / biometric enrolment (`CreatePlatformDiscoveries`, `ConfigureDiscoveries`, `OnSampleCollected`, `StartBioEnrollment`) | **not feasible / N-A** | Linux has no *platform* authenticator, so there is nothing to discover or enrol. This is the interface a genuine Linux platform authenticator would implement — the place the fingerprint-gated backend of `omarchy-passkey-broker` would plug in *if* it were to become a platform authenticator instead of a browser bridge. Out of scope for the browser plugin. |
| passkey-store signalling (`SignalAllAcceptedCredentials`, `UpdateUserPasskeys`, `PasskeyUnrecognized`); `BrowserProvidedPasskeysAvailable` = false | **accepted — correct as-is** | Qt has no credential store or cloud keychain, so there is nothing to signal and `false` is truthful. Implementing them would be faking a feature. Relevant only if a real store is added. |
| attestation policy (`ShouldPermitIndividualAttestation`), relying-party override, caller-origin override, `IsFocused`, `GetGenerateRequestIdCallback` | **accepted — correct as-is** | Qt's defaults are the right answer; "closing" them would mean un-correcting a correct default. |
| two `MessagePumpForUIQt::Run/Quit` NOTIMPLEMENTED | **accepted** | Qt's own comment: only used outside the GUI thread; not in normal use. |
| `RenderWidgetHostViewQt::EnsureSurfaceSynchronizedForWebTest` NOTIMPLEMENTED | **accepted** | test-only, not shipped behaviour. |
| `AutofillClientQt::GetAutofillSuggestions` NOTIMPLEMENTED | **accepted — correct** | Qt's comment: password-manager only; with KeePassXC the empty return is right. |
| `ClipboardQt::ReadBookmark` NOTIMPLEMENTED | **accepted — minor** | X11 selection bookmark; a real but tiny gap, unrelated to sign-in. |
| `CreateVulkanImplementation` NOTIMPLEMENTED | **accepted — unreachable** | inside `#if BUILDFLAG(IS_APPLE)` (MoltenVK); Linux does not take that path. |
| `vulkan_implementation_qt` NOTIMPLEMENTED | **accepted** | only with the Vulkan compositor build; not used here. |
| `extensions_browser_client_qt` NOTIMPLEMENTED | **accepted** | Chrome-extension surface Qt only partly implements; qutebrowser does not use extensions. |
| `PageAlmostIdle` not implemented | **accepted — cosmetic** | a performance metric. |

## qutebrowser / this plugin

| gap | status | detail |
|---|---|---|
| qutebrowser never connects `QWebEnginePage.webAuthUxRequested`, so a ceremony hangs | **closed** | `config/omarchy_webauthn.py` wires it (constructor hooks + a sweep). |
| the handler only drove the happy path | **closed** | it now surfaces the PIN error, the minimum length and the remaining attempts; offers a **retry** on the recoverable failures (`Timeout`, `AuthenticatorRemovedDuringPinEntry`); maps all thirteen failure reasons to sentences; and announces `Completed` / `Cancelled`. |
| Google requires `userscripts/omarchy-google-signin-chrome-identity.js` | **accepted — documented cost** | a page-visible deviation. The engine patch is necessary but not sufficient for Google. Moving it into the engine would mean making the engine impersonate Chrome, which is the very thing anti-abuse punishes and would break other sites' truthful-identity handling. Kept, scoped, and covered by a regression guard. |
| Microsoft platform-probe userscript | **closed / retired** | the engine patch replaced it; the userscript is disabled (kept as a fallback only). |
| KeePassXC auto-fill clobbering a passkey frame | **closed** | `qute-keepassxc-fill` declines on `bridge/fido`, `/webauthn` and `/signin/challenge/pk`. |

## Engine-patch durability (a guard, not a gap)

The two engine fixes are a **text-matched patch** of Qt's source
(`docs/engine-patch/apply-webauthn-patch.py`). A Qt upgrade can move the code, at which point the
patch silently becomes a no-op and the browser stops offering passkeys — with nothing else failing.

- **`--check` mode** (added): verifies the anchors and reports `patched` / `appliable` / `drift`
  without writing anything, exiting non-zero on drift. `build-patched-engine.sh` already refuses to
  build an unpatched tree; `--check` is the pre-flight and the test-suite guard.
- **`tests/shell/test_engine_patch.sh`** runs `--check` against the real checkout (SKIPs cleanly when
  the 9 GB source is absent, e.g. CI) and drives apply → revert → check → drift on a throwaway copy.
- Two latent bugs it exposed and that are now fixed: `revert` deleted the patched block instead of
  restoring the original body (leaving a headless function), and `apply` wrote the impl twice —
  once for the presentation fix and once from the pre-fix text — so a *fresh* apply silently lost
  the presentation fix (it had only ever worked because the source was patched twice).

## How each "closed" item is tested

- engine capability + the handler against real Qt: `tests/e2e/test_webauthn_ux_e2e.sh`
  (offscreen QtWebEngine; also asserts the engine reports a platform authenticator when the
  patched build is installed).
- the handler's state machine, PIN messages, failure mapping and retry: `tests/test_unit_webauthn.py`.
- mutation: `config/omarchy_webauthn.py` is a mutation target (floor 0.80; currently 1.00).

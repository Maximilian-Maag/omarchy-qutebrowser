# Engine patches: make QtWebEngine do passkeys properly

Two confined patches to Qt's own files that remove the need for the page-visible userscript, and
remove a hang:

| # | what | where | why |
|---|---|---|---|
| 1 | report a platform authenticator as available | `WebAuthenticationDelegateQt` | pages otherwise conclude "this browser cannot do passkeys" and never start a ceremony |
| 2 | present a conditional request as modal | `AuthenticatorRequestClientDelegateQt::SetUIPresentation` | a `mediation:"conditional"` request is marked `kAutofill`, which Qt shows nothing for, and such a request never times out — the page waits forever |

Both are applied by `apply-webauthn-patch.py` (with `--revert`) and built by `build-patched-engine.sh`.

## Patch 1 — the capability answer

Chromium routes "is a user-verifying platform authenticator available?" through the embedder:

```
content/public/browser/web_authentication_delegate.h
    virtual void IsUserVerifyingPlatformAuthenticatorAvailableOverride(
        RenderFrameHost* render_frame_host,
        base::OnceCallback<void(std::optional<bool>)> callback);

content/browser/webauth/authenticator_common_impl.cc
    GetWebAuthenticationDelegate()
        ->IsUserVerifyingPlatformAuthenticatorAvailableOverride( ... );   // 4 call sites
```

QtWebEngine subclasses it (`WebAuthenticationDelegateQt`) and overrides only `SupportsResidentKeys`,
so the default answer stands: `false`, because Linux has no *platform* authenticator. Pages read that
as "this browser cannot do passkeys" and never start a ceremony.

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
which is why it is the right fix and the userscript is only a stopgap.

## Patch 2 — the conditional-request hang

A relying party can call `navigator.credentials.get({mediation: "conditional"})` to ask for the
passkey to be *suggested* in its own form as the user types. Chromium marks that presentation
`kAutofill`, and QtWebEngine deliberately shows nothing for it — because the autofill dropdown is
supposed to belong to an autofill component, which Qt does not have:

```cpp
// authenticator_request_dialog_controller.cpp, before patch 2
AuthenticatorRequestDialogControllerPrivate::showWebAuthDialog()
{
    if (m_uiPresentation == UIPresentation::kAutofill)
        return;                       // <- no dialog, ever
```

A conditional request is designed **never to time out**, so the page sits on "Signing in with your
passkey..." with nothing clickable — forever. Measured: this is the hang.

There is a second suppression of the same kind in the account-selection path
(`AuthenticatorRequestClientDelegateQt::SelectAccount`), which is why the fix is applied at the entry
point: convert the presentation so it never becomes `kAutofill` in the first place.

```cpp
void AuthenticatorRequestClientDelegateQt::SetUIPresentation(UIPresentation ui_presentation)
{
    // Qt has no autofill component to hand a conditional request to, so the honest fallback is the
    // ordinary modal prompt: the user gets the passkey chooser instead of a spinner.
    if (ui_presentation == UIPresentation::kAutofill)
        ui_presentation = UIPresentation::kModal;

    m_isUiDisabled = (ui_presentation == UIPresentation::kDisabled);
    m_dialogController->setUiPresentation(ui_presentation);
}
```

This **removes the hang**; it is not a real autofill dropdown. Building one would be a UI project
(the dropdown, plus the `SetCredentialIdFilter` / `SetHints` / `SetCredentialTypes` /
`SetUserEntityForMakeCredentialRequest` plumbing) — see `../webauthn-signin.md`, "Implementation gap
analysis".

## Why no Chromium file is touched

Both hooks already exist in Chromium and are routed to the embedder; Qt simply never filled them in.
The changes are confined to Qt's two files (`src/core/authenticator_request_client_delegate_qt.{h,cpp}`),
which keeps them reviewable and the build reproducible across Qt upgrades.

## Requirements

Building QtWebEngine needs a large toolchain. On Arch, most of it is already present if
`qt6-webengine` is installed. What was missing, installed here into `~/.local` so no root was
required:

| tool | how |
|---|---|
| cmake, ninja, html5lib | `pip install --user cmake ninja html5lib` |
| gperf | built from the GNU tarball into `~/.local` |
| jsoncpp | built from source into `~/.local` |
| node | already present (mise) |

Not needed for compilation, and therefore skipped: `perf` (used by the packaging check) and
`qt6-tools` (the build's configure phase passes without it).

## Procedure

```bash
# 1. fetch the packaging recipe and the sources (~9 GB); no root needed
git clone --depth=1 https://gitlab.archlinux.org/archlinux/packaging/packages/qt6-webengine.git
cd qt6-webengine
makepkg -o -d

# 2. apply the patches to Qt's delegate
python3 ../apply-webauthn-patch.py

# 3. build (no root: this compiles only, it does not install)
../build-patched-engine.sh

# 4. install (this is the only step that needs root)
sudo pacman -U qt6-webengine-*.pkg.tar.zst
```

`build-patched-engine.sh` refuses to build if patch 1 is missing, and uses `--noprepare` — the
PKGBUILD's `prepare()` performs a submodule checkout that resets `src/3rdparty`, which would silently
wipe the patches and produce a three-hour build of unpatched code.

`-d` skips the dependency check (for the two absent, unneeded packages above), `-e` reuses the
fetched sources, `--nocheck` skips QtWebEngine's own test suite, and `-f` overwrites a package left
by an earlier build (without it, `makepkg` aborts with "A package has already been built").

Expect 1–3 hours on 12 cores for a cold build, and around 50 GB of disk. The **second** build is
incremental — ninja recompiles only the touched translation unit and relinks — and took about ten
minutes here.

## Verifying the patches are applied

```bash
grep -c IsUserVerifyingPlatformAuthenticatorAvailableOverride \
    src/qtwebengine/src/core/authenticator_request_client_delegate_qt.{h,cpp}
# expect 1 in each

grep -n 'ui_presentation = UIPresentation::kModal' \
    src/qtwebengine/src/core/authenticator_request_client_delegate_qt.cpp
# expect one hit
```

The packages strip non-exported symbols, so the shipped `.so` is not the place to look. The compiled
object is the evidence:

```bash
OBJ=src/build/src/core/RelWithDebInfo/x86_64/obj/QtWebEngineCore/authenticator_request_client_delegate_qt.o
nm -C "$OBJ" | grep IsUserVerifyingPlatformAuthenticatorAvailableOverride   # a 'T' definition
objdump -d -C "$OBJ" | grep -A40 SetUIPresentation | grep cmp               # cmp $0x2 (kAutofill) before $0x4 (kDisabled)
```

The `cmp $0x2` is what patch 2 adds; without it the function only compares against `kDisabled`.

After installing, attempt a passkey sign-in on `login.live.com` with the userscript disabled:

```bash
mv ~/.local/share/qutebrowser/greasemonkey/omarchy-ms-passkey-platform-probe.js{,.off}
# restart qutebrowser, then:
journalctl --user -u <unit> -f | grep -iE "WebAuthn UX|FIDO:"
```

A `WebAuthn UX request for rp='login.microsoft.com'` line means the page was offered the passkey
without any page-visible correction. Restore the userscript if you need it as a fallback
(`mv ...js{.off,}`).

### Behavioural verification

Both patches were verified against a real offscreen QtWebEngine, each run with the patched library
and with the unpatched one (`LD_LIBRARY_PATH` pointing at a copy of the previous
`libQt6WebEngineCore.so`), so the only difference is the patch.

**Patch 1 — the capability answer.** Load a secure origin and evaluate
`isUserVerifyingPlatformAuthenticatorAvailable()`:

| library | answer |
|---|---|
| unpatched | `false` |
| patched | `true` |

**Patch 2 — the conditional-request presentation.** Issue
`navigator.credentials.get({ mediation: ... })` from a page and watch whether the browser engages its
WebAuthn UX — `QWebEnginePage.webAuthUxRequested`, the signal a browser must wire, which the same
probe records along with the states it reaches:

| library | `mediation: 'optional'` | `mediation: 'conditional'` |
|---|---|---|
| unpatched | UX engaged (`CollectPin`) | **no UX at all** — the hang |
| patched | UX engaged (`CollectPin`) | UX engaged (`CollectPin`) |

The `optional` column is the control: a modal request behaves identically either way, so the only
thing the patches change is the conditional case — exactly the `kAutofill` suppression patch 2
removes. (`mediation: 'modal'` is not a valid value and throws `TypeError`; the modal flow is
`'optional'`.)

## Durability — a system upgrade reverts the INSTALL, not just the source

The patch lives in a package you built; Arch does not know it exists. **Any `qt6-webengine` upgrade —
`pacman -Syu`, or reinstalling the stock package — replaces `libQt6WebEngineCore.so` and reverts both
patches silently.** The symptom returns exactly as before: passkey pages spin with nothing clickable,
and the engine emits no `WebAuthn UX request` at all.

There are two distinct failure modes and they are detected differently:

| what changed | detector |
|---|---|
| a Qt upgrade moved the code the patch anchors on (**source drift**) | `apply-webauthn-patch.py --check` — and `tests/shell/test_engine_patch.sh` — fails loudly, because the patch would silently become a no-op |
| a system upgrade replaced the **installed** library while the source stays patched | `--check` still passes (the source is fine). The detector is behavioural: `tests/e2e/test_webauthn_ux_e2e.sh` reports `E2E UVPA=true` on a patched engine and SKIPs with a message when the running engine is stock |

So after any `qt6-webengine` upgrade, check the **running** engine, not just the source:

```bash
bash tests/e2e/test_webauthn_ux_e2e.sh        # want: E2E UVPA=true
```

If it reports `false`, rebuild and reinstall:

```bash
python3 docs/engine-patch/apply-webauthn-patch.py     # idempotent; also re-applies after source drift
python3 docs/engine-patch/build-patched-engine.sh     # incremental; ~10 min when only this file changed
sudo pacman -U ~/Work/qt6-webengine-build/qt6-webengine/qt6-webengine-*.pkg.tar.zst
```

## Reverting

```bash
python3 apply-webauthn-patch.py --revert
```

Or, without rebuilding, restore the previous library if it was backed up:

```bash
sudo cp ~/Work/qt6-webengine-build/rollback/libQt6WebEngineCore.so.6.11.2 \
        /usr/lib/libQt6WebEngineCore.so.6.11.2
```

## Pitfalls learned while building this

- **Appending a definition to the end of a Qt `.cpp` puts it outside the namespace.** Qt wraps these
  files in `namespace QtWebEngineCore { … }`, so a definition after the closing brace fails with
  `'WebAuthenticationDelegateQt' has not been declared`. Anchor on the end of the existing override's
  body instead. This is exactly how the first build failed, at `23175/23286`.
- **`#pragma once` is not universal.** Qt headers use `#ifndef` include guards, so an edit that
  anchors on `#pragma once` silently does nothing. Anchoring on real content is safer.
- **`makepkg` will not overwrite a package from a previous run** — it aborts with "A package has
  already been built". Pass `-f`.
- **`prepare()` resets the source tree.** Hence `--noprepare`; without it the patches are wiped
  immediately before a multi-hour build.

## Limits

These fix the *capability* answer and the conditional-request hang. They do not make the engine
identify as Chrome, and that matters: measured, the engine patch is **necessary but not sufficient**
for Google. With the patch *plus* `userscripts/omarchy-google-signin-chrome-identity.js`, Google signs
in; with the patch alone (userscript disabled) Google refuses, "This browser or app may not be
secure". For Microsoft the patch alone is enough. See `../webauthn-signin.md`, "Known limits".

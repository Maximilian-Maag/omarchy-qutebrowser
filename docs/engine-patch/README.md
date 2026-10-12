# Engine patch: make QtWebEngine report a platform authenticator

Removes the need for the Microsoft platform-probe userscript by fixing the cause in the engine.

## Why this works, and why it is the right fix

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

`apply-webauthn-patch.py` adds one override that answers `true`. **No Chromium file is touched** —
the change is confined to Qt's two files, which keeps it reviewable and the build reproducible.

The result is native and therefore **not detectable by the page**, unlike the userscript it replaces.

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

# 2. apply the patch to Qt's delegate
python3 ../apply-webauthn-patch.py

# 3. build (no root: this compiles only, it does not install)
../build-patched-engine.sh

# 4. install (this is the only step that needs root)
sudo pacman -U qt6-webengine-*.pkg.tar.zst
```

`build-patched-engine.sh` refuses to build if the patch is missing, and uses `--noprepare` — the
PKGBUILD's `prepare()` performs a submodule checkout that resets `src/3rdparty`, which would silently
wipe the patch and produce a three-hour build of unpatched code.

`-d` skips the dependency check (for the two absent, unneeded packages above), `-e` reuses the
fetched sources, and `--nocheck` skips QtWebEngine's own test suite.

Expect 1–3 hours on 12 cores, and around 50 GB of disk.

## Verifying the patch is applied

```bash
grep -c IsUserVerifyingPlatformAuthenticatorAvailableOverride \
    src/qtwebengine/src/core/authenticator_request_client_delegate_qt.{h,cpp}
# expect 1 in each
```

After installing, attempt a passkey sign-in on `login.live.com` with the userscript disabled:

```bash
mv ~/.local/share/qutebrowser/greasemonkey/omarchy-ms-passkey-platform-probe.js{,.off}
# restart qutebrowser, then:
journalctl --user -u <unit> -f | grep -iE "WebAuthn UX|FIDO:"
```

A `WebAuthn UX request for rp='login.microsoft.com'` line means the page was offered the passkey
without any page-visible correction. Restore the userscript if you need it as a fallback
(`mv ...js{.off,}`).

## Reverting

```bash
python3 apply-webauthn-patch.py --revert
```

## Limits

This fixes the *capability* answer. It does not make the engine identify as Chrome, so Google's
account sign-in remains refused — see `../webauthn-signin.md`, "Known limits".

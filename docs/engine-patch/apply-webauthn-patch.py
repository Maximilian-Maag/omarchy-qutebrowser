#!/usr/bin/env python3
"""Apply the QtWebEngine WebAuthn platform-authenticator patch.

Why: QtWebEngine has no *platform* authenticator (Linux has none; a YubiKey is cross-platform), so
it answers Chromium's platform-authenticator question with "no". A relying party's page reads that
as "this browser cannot do passkeys" and never starts a ceremony - it spins forever. Measured in
this browser: the engine drives FIDO2 keys perfectly when a page does call it (a full ceremony
completed: CollectPin -> FinishTokenCollection -> Completed), so exactly one answer is wrong.

How: Chromium already routes the answer through the embedder - WebAuthenticationDelegate::
IsUserVerifyingPlatformAuthenticatorAvailableOverride() (four call sites in
content/browser/webauth/authenticator_common_impl.cc). QtWebEngine subclasses that delegate. So the
patch is confined to Qt's two files: override the hook and answer true. No Chromium file is touched,
which keeps the change reviewable and the build reproducible.

Run:  python3 apply-webauthn-patch.py [--revert]
"""
import pathlib
import subprocess
import sys

SRC = pathlib.Path.home() / "Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core"
HEADER = SRC / "authenticator_request_client_delegate_qt.h"
IMPL = SRC / "authenticator_request_client_delegate_qt.cpp"

DECL = """
    // Report a platform authenticator as available. QtWebEngine answers "no" because Linux has no
    // platform authenticator, so pages conclude passkeys are unsupported and never start a
    // ceremony. The engine drives FIDO2 security keys correctly; only this answer is wrong.
    void IsUserVerifyingPlatformAuthenticatorAvailableOverride(
        content::RenderFrameHost *render_frame_host,
        base::OnceCallback<void(std::optional<bool>)> callback) override;
"""

DEFN = """
// Chromium asks the embedder whether a user-verifying platform authenticator is available, and a
// relying party reads the answer as "can this browser do passkeys at all". Linux has no platform
// authenticator, so the truthful answer here is a hard "no" as far as the *platform* is concerned -
// which is why pages never offered the passkey, even though a FIDO2 security key works.
//
// Report it as available so those pages start the ceremony. The security key still performs the
// user verification (PIN / touch); nothing is bypassed, the page is simply not told to give up.
void WebAuthenticationDelegateQt::IsUserVerifyingPlatformAuthenticatorAvailableOverride(
        content::RenderFrameHost *render_frame_host,
        base::OnceCallback<void(std::optional<bool>)> callback)
{
    Q_UNUSED(render_frame_host);
    std::move(callback).Run(true);
}
"""


FIX_OLD = """void AuthenticatorRequestClientDelegateQt::SetUIPresentation(UIPresentation ui_presentation)
{
    m_isUiDisabled = (ui_presentation == UIPresentation::kDisabled);"""

FIX_NEW = """void AuthenticatorRequestClientDelegateQt::SetUIPresentation(UIPresentation ui_presentation)
{
    // QtWebEngine implements no passkey autofill UI. A conditional request (mediation =
    // "conditional") is marked kAutofill, and the dialog controller deliberately shows nothing for
    // that presentation - while such a request is designed never to time out, so the page waits
    // forever ("Signing in with your passkey...", nothing clickable). Measured: that is the hang.
    //
    // Qt has no autofill component to hand this to, so the honest fallback is the ordinary modal
    // prompt: the user gets the passkey chooser instead of a spinner. Closing this by building a
    // real autofill dropdown would be a UI project; this removes the hang.
    if (ui_presentation == UIPresentation::kAutofill)
        ui_presentation = UIPresentation::kModal;

    m_isUiDisabled = (ui_presentation == UIPresentation::kDisabled);"""


def revert():
    done = False
    for path, needle in ((HEADER, DECL), (IMPL, DEFN), (IMPL, FIX_NEW)):
        text = path.read_text()
        if needle in text:
            path.write_text(text.replace(needle, ""))
            print("  reverted", path.name)
            done = True
    if not done:
        print("  nothing to revert (patch not present)")


def main():
    if "--revert" in sys.argv:
        revert()
        return 0

    header = HEADER.read_text()
    impl = IMPL.read_text()

    impl_now = IMPL.read_text()
    if "ui_presentation = UIPresentation::kModal" in impl_now:
        print("  presentation fix already applied")
    elif FIX_OLD in impl_now:
        IMPL.write_text(impl_now.replace(FIX_OLD, FIX_NEW, 1))
        print("  presentation fix applied (kAutofill -> kModal)")
    else:
        print("  ANCHOR NOT FOUND for the presentation fix", file=sys.stderr)
        return 1

    if "IsUserVerifyingPlatformAuthenticatorAvailableOverride" in header:
        print("  already patched")
        return 0

    if "IsUserVerifyingPlatformAuthenticatorAvailableOverride" in header:
        print("  header already carries the override")

    # 1. the declaration, next to the one override Qt already has.
    anchor = "    bool SupportsResidentKeys(content::RenderFrameHost *render_frame_host) override;"
    if anchor not in header:
        print("  ANCHOR NOT FOUND in the header - the source layout changed", file=sys.stderr)
        return 1
    header = header.replace(anchor, anchor + DECL, 1)
    if "#include <optional>" not in header:
        header = header.replace("#pragma once", "#pragma once\n\n#include <optional>", 1)
    HEADER.write_text(header)

    # 2. the definition, after the existing override's body.
    # The definition must land INSIDE `namespace QtWebEngineCore`, so anchor on the end of the
    # existing override's body rather than appending to the file - appending puts it after the
    # closing brace, where the class is not visible ("'WebAuthenticationDelegateQt' has not been
    # declared"). Measured: that is exactly how the first build failed at 23175/23286.
    tail_anchor = """bool WebAuthenticationDelegateQt::SupportsResidentKeys(content::RenderFrameHost *render_frame_host)
{
    return true;
}"""
    if tail_anchor not in impl:
        print("  ANCHOR NOT FOUND in the implementation", file=sys.stderr)
        return 1
    IMPL.write_text(impl.replace(tail_anchor, tail_anchor + "\n" + DEFN, 1))

    print("  patched:", HEADER.name, "and", IMPL.name)
    print()
    print(subprocess.run(["git", "diff", "--", str(HEADER), str(IMPL)],
                         cwd=str(SRC), capture_output=True, text=True).stdout or
          "  (files are not in a git tree; showing targeted context instead)")
    for name in ("authenticator_request_client_delegate_qt.h",
                 "authenticator_request_client_delegate_qt.cpp"):
        print("  --- %s" % name)
        for i, line in enumerate((SRC / name).read_text().splitlines(), 1):
            if "IsUserVerifyingPlatformAuthenticatorAvailableOverride" in line:
                print("    %d: %s" % (i, line.strip()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

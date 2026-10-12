#!/usr/bin/env python3
"""Apply (or verify) the QtWebEngine WebAuthn platform-authenticator patch.

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

A second, smaller fix: a conditional ("autofill") request is marked UIPresentation::kAutofill, for
which Qt's dialog controller shows nothing while the request is designed never to time out - so the
page hangs. Qt has no autofill component, so the honest fallback is to present it as kModal.

Modes:
  (default)     apply the patch to the source in place
  --revert      remove the patch from the source in place
  --check       verify the anchors and report state WITHOUT writing anything; exits
                0 when the source is patched or cleanly appliable, 2 on anchor drift
                (a Qt upgrade moved the code - the patch would silently stop applying)
  --src DIR     operate on DIR instead of the default checkout (for --check in the test suite)

Why --check matters: the patch is text-matched, so a Qt source change can make it a no-op. This
mode is the guard - the test suite runs it so drift fails loudly instead of regressing sign-in.

Run:  python3 apply-webauthn-patch.py [--revert | --check] [--src DIR]
"""
import pathlib
import sys

SRC_DEFAULT = pathlib.Path.home() / "Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core"
HEADER_NAME = "authenticator_request_client_delegate_qt.h"
IMPL_NAME = "authenticator_request_client_delegate_qt.cpp"

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

# Anchors that identify where to insert. They remain in the text after patching, so they are a good
# "can this still be applied?" signal - not an "is it applied?" signal (the markers below are that).
HEADER_ANCHOR = "    bool SupportsResidentKeys(content::RenderFrameHost *render_frame_host) override;"
TAIL_ANCHOR = """bool WebAuthenticationDelegateQt::SupportsResidentKeys(content::RenderFrameHost *render_frame_host)
{
    return true;
}"""

UVPA_MARKER = "IsUserVerifyingPlatformAuthenticatorAvailableOverride"
PRES_MARKER = "ui_presentation = UIPresentation::kModal"


def paths(src):
    return src / HEADER_NAME, src / IMPL_NAME


def status(src):
    """Classify each fix as patched / appliable / drift, without touching the files."""
    header, impl = (p.read_text() for p in paths(src))
    return {
        "uvpa": "patched" if UVPA_MARKER in header
                else "appliable" if (HEADER_ANCHOR in header and TAIL_ANCHOR in impl)
                else "drift",
        "presentation": "patched" if PRES_MARKER in impl
                        else "appliable" if FIX_OLD in impl
                        else "drift",
    }


def check(src):
    if not all(p.exists() for p in paths(src)):
        print("  source not found under %s" % src, file=sys.stderr)
        return 3
    st = status(src)
    print("  engine source: %s" % src)
    for name in ("uvpa", "presentation"):
        print("  %-13s %s" % (name, st[name]))
    if st["uvpa"] == "drift" or st["presentation"] == "drift":
        print("  ANCHOR DRIFT: a Qt source change broke the patch. Re-derive the anchors before "
              "building, or the browser will silently stop offering passkeys.", file=sys.stderr)
        return 2
    if st["uvpa"] == "patched" and st["presentation"] == "patched":
        print("  OK: patched")
    else:
        print("  OK: appliable")
    return 0


def revert(src):
    """Undo the patch: remove the added override and RESTORE the original presentation body.

    The presentation fix replaced FIX_OLD (the original body) with FIX_NEW, so reverting must put
    FIX_OLD back - merely deleting FIX_NEW would delete the function's opening brace and its
    kDisabled line too, leaving a headless, uncompilable function.
    """
    done = False
    header_path, impl_path = paths(src)
    if header_path.exists():
        text = header_path.read_text()
        if DECL in text:
            header_path.write_text(text.replace(DECL, ""))
            print("  reverted", header_path.name)
            done = True
    if impl_path.exists():
        text = impl_path.read_text()
        if DEFN in text:
            text = text.replace(DEFN, "")
        if FIX_NEW in text:
            text = text.replace(FIX_NEW, FIX_OLD)
            done = True
        impl_path.write_text(text)
    if not done:
        print("  nothing to revert (patch not present)")


def apply_patch(src):
    """Apply both fixes to one in-memory copy of each file, then write each file once.

    Writing the files piecemeal is how the presentation fix used to vanish: the impl was written
    for the presentation fix and then written AGAIN from the pre-fix text for the uvpa definition,
    clobbering it. A fresh apply lost one of the two fixes; it only ever worked because the source
    had been patched twice. One copy, one write per file.
    """
    header_path, impl_path = paths(src)
    header = header_path.read_text()
    impl = impl_path.read_text()
    problems = []

    if PRES_MARKER in impl:
        print("  presentation fix already applied")
    elif FIX_OLD in impl:
        impl = impl.replace(FIX_OLD, FIX_NEW, 1)
        print("  presentation fix applied (kAutofill -> kModal)")
    else:
        problems.append("presentation fix (SetUIPresentation body)")

    if UVPA_MARKER in header:
        print("  uvpa fix already applied")
    elif HEADER_ANCHOR in header and TAIL_ANCHOR in impl:
        header = header.replace(HEADER_ANCHOR, HEADER_ANCHOR + DECL, 1)
        if "#include <optional>" not in header:
            header = header.replace("#pragma once", "#pragma once\n\n#include <optional>", 1)
        impl = impl.replace(TAIL_ANCHOR, TAIL_ANCHOR + "\n" + DEFN, 1)
        print("  uvpa fix applied")
    else:
        problems.append("uvpa fix (SupportsResidentKeys anchors)")

    if problems:
        print("  ANCHOR NOT FOUND: %s - the source layout changed" % ", ".join(problems),
              file=sys.stderr)
        return 1

    header_path.write_text(header)
    impl_path.write_text(impl)
    print("  patched:", HEADER_NAME, "and", IMPL_NAME)
    return 0


def main(argv):
    src = SRC_DEFAULT
    if "--src" in argv:
        src = pathlib.Path(argv[argv.index("--src") + 1])
    if "--check" in argv:
        return check(src)
    if "--revert" in argv:
        revert(src)
        return 0
    return apply_patch(src)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

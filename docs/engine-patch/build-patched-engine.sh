#!/bin/bash
# Build the patched QtWebEngine. No root: this only compiles, it does not install.
#
# The patch (apply-webauthn-patch.py) makes QtWebEngine's WebAuthenticationDelegate report a
# platform authenticator as available, so relying-party pages offer the passkey instead of
# concluding the browser cannot do them.
#
#   -e           reuse the already-downloaded source (9.2 GB), do not re-extract
#   --noprepare  do NOT run prepare(), which does a submodule checkout that resets src/3rdparty -
#                that reset is what would wipe the patch
#   --nocheck    skip QtWebEngine's own test suite (a large part of the build time)
#   -d           skip the dependency check: perf and qt6-tools are absent, and neither is needed
#                for compilation (perf is used by the packaging check)
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export CMAKE_PREFIX_PATH="$HOME/.local"

SRC="$HOME/Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core"
for f in authenticator_request_client_delegate_qt.h authenticator_request_client_delegate_qt.cpp; do
    if ! grep -q IsUserVerifyingPlatformAuthenticatorAvailableOverride "$SRC/$f"; then
        echo "!!! PATCH MISSING in $f - refusing to build unpatched code" >&2
        exit 9
    fi
done
echo "==> patch verified in both files; starting the build"

cd "$HOME/Work/qt6-webengine-build/qt6-webengine" || exit 8
makepkg -e --noprepare --nocheck -d
rc=$?
echo "BUILD_EXIT=$rc"
ls -la "$HOME/Work/qt6-webengine-build/qt6-webengine"/*.pkg.tar.* 2>/dev/null
exit $rc

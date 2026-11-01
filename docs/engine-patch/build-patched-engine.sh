#!/bin/bash
# Build the patched QtWebEngine. No root: this only compiles, it does not install.
#
# Three fixes ship as text-matched patches of Qt's source:
#   apply-webauthn-patch.py     patch 1 (platform-authenticator answer) + patch 2 (conditional
#                               request presented as modal instead of the silent kAutofill)
#   apply-engine-stubs-patch.py the four QT_NOT_YET_IMPLEMENTED stubs (a11y + clipboard)
#
# A text-matched patch is one Qt refactor away from being a silent no-op, so this script APPLIES
# both patches (idempotently) and then REQUIRES each to report "OK: patched". Requiring "patched"
# - not merely a zero exit - is the point: the patch scripts' --check returns 0 for an *appliable*
# (i.e. UNPATCHED) tree too, so a guard that accepted rc 0 would happily build unpatched code, the
# very failure it exists to prevent.
#
#   --check-only  run the guard and exit (0 = patched and ready, 9 = refuse); do not build.
#                 The test suite drives this against a scratch copy (see OMARCHY_ENGINE_SRC).
#   OMARCHY_ENGINE_SRC  override the source directory (used by the test suite and --check-only).
#
#   -e           reuse the already-downloaded source (9.2 GB), do not re-extract
#   --noprepare  do NOT run prepare(), which does a submodule checkout that resets src/3rdparty -
#                that reset is what would wipe the patches
#   --nocheck    skip QtWebEngine's own test suite (a large part of the build time)
#   -d           skip the dependency check: perf and qt6-tools are absent, and neither is needed
#                for compilation (perf is used by the packaging check)
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export CMAKE_PREFIX_PATH="$HOME/.local"

SRC="${OMARCHY_ENGINE_SRC:-$HOME/Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core}"
PATCHDIR="$(cd "$(dirname "$0")" && pwd)"

CHECK_ONLY=""
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

# Apply both patches (idempotent: each reports "already applied" when present). If an anchor is
# gone - a Qt upgrade moved the code - the apply fails and we refuse below.
for script in apply-webauthn-patch.py apply-engine-stubs-patch.py; do
    if ! python3 "$PATCHDIR/$script" --src "$SRC"; then
        echo "!!! $script could not be applied (anchor drift?) - refusing to build unpatched code" >&2
        exit 9
    fi
done

# Require the tree to ACTUALLY carry the edits. "OK: patched" is printed only when every anchor is
# present; "OK: appliable" (an unpatched tree) must not pass.
ok=1
for script in apply-webauthn-patch.py apply-engine-stubs-patch.py; do
    if ! python3 "$PATCHDIR/$script" --check --src "$SRC" | grep -q "OK: patched"; then
        ok=0
    fi
done
if [ "$ok" -ne 1 ]; then
    echo "!!! engine patches not fully applied - refusing to build" >&2
    echo "    (webauthn patch 1 AND 2, and all four stubs, must report 'patched')" >&2
    python3 "$PATCHDIR/apply-webauthn-patch.py" --check --src "$SRC" >&2
    python3 "$PATCHDIR/apply-engine-stubs-patch.py" --check --src "$SRC" >&2
    exit 9
fi
echo "==> patches verified (webauthn 1+2, a11y, clipboard); engine source is patched"

[ -n "$CHECK_ONLY" ] && exit 0

cd "$HOME/Work/qt6-webengine-build/qt6-webengine" || exit 8
makepkg -e --noprepare --nocheck -d -f
rc=$?
echo "BUILD_EXIT=$rc"
ls -la "$HOME/Work/qt6-webengine-build/qt6-webengine"/*.pkg.tar.* 2>/dev/null
exit $rc

#!/bin/bash
# Guard the QtWebEngine engine patch.
#
# The passkey fix is a TEXT-MATCHED patch of Qt's source (docs/engine-patch/apply-webauthn-patch.py).
# A Qt upgrade can move the code, at which point the patch silently stops applying and the browser
# stops offering passkeys - with nothing else in the suite failing. This test runs the patch's
# --check mode so that drift fails LOUDLY, and drives the apply/revert/check cycle on a throwaway
# copy so the anchors are exercised without touching the real source.
#
# Skips cleanly when the engine source is not present (CI has no 9 GB checkout).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO/docs/engine-patch/apply-webauthn-patch.py"
SRC="${OMARCHY_ENGINE_SRC:-$HOME/Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core}"
HDR="authenticator_request_client_delegate_qt.h"
IMP="authenticator_request_client_delegate_qt.cpp"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS: $1"; }
no() { fail=$((fail + 1)); echo "  FAIL: $1"; }
skip() { echo "  SKIP: $1"; }

if [ ! -f "$SRC/$HDR" ] || [ ! -f "$SRC/$IMP" ]; then
  skip "engine source not present at $SRC (nothing to guard here)"
  echo "shell: 0 passed, 0 failed (skipped)"
  exit 0
fi

# ── 1. the real source is healthy, and on this machine it is patched ──────────
out="$(python3 "$SCRIPT" --check --src "$SRC" 2>&1)"
rc=$?
if (( rc == 0 )); then
  ok "--check on the real engine source is healthy"
else
  no "--check on the real engine source returned $rc"
  printf '%s\n' "$out" | sed 's/^/    /'
fi
if printf '%s\n' "$out" | grep -q "OK: patched"; then
  ok "the engine source carries the patch (uvpa + presentation)"
else
  no "the engine source is not fully patched"
fi

# ── 2. apply / revert / check on a throwaway copy ─────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$SRC/$HDR" "$SRC/$IMP" "$tmp/"

python3 "$SCRIPT" --src "$tmp" --revert >/dev/null 2>&1
if python3 "$SCRIPT" --check --src "$tmp" 2>&1 | grep -q "OK: appliable"; then
  ok "a reverted (unpatched) copy is reported appliable - revert restores the original body"
else
  no "a reverted copy is not appliable: revert left the source in a broken state"
  python3 "$SCRIPT" --check --src "$tmp" 2>&1 | sed 's/^/    /'
fi

python3 "$SCRIPT" --src "$tmp" >/dev/null 2>&1
if python3 "$SCRIPT" --check --src "$tmp" 2>&1 | grep -q "OK: patched"; then
  ok "applying the patch to the copy puts it back in the patched state"
else
  no "applying the patch to the copy did not reach the patched state"
fi

# ── 3. anchor drift is detected (on an UNPATCHED copy, where the anchor is still needed) ──
python3 "$SCRIPT" --src "$tmp" --revert >/dev/null 2>&1
python3 - "$tmp/$HDR" <<'PY'
import pathlib
import sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("SupportsResidentKeys", "SupportsResidentKeysRenamed"))
PY
if python3 "$SCRIPT" --check --src "$tmp" >/dev/null 2>&1; then
  no "anchor drift was NOT detected - a Qt upgrade could silently un-patch the browser"
else
  ok "anchor drift is detected (--check fails loudly)"
fi

# ── 4. the engine STUBS patch (a11y + clipboard implementations) ──────────────
# Same contract, different script: docs/engine-patch/apply-engine-stubs-patch.py fills in Qt's
# QT_NOT_YET_IMPLEMENTED stubs that are real and reachable (see docs/implementation-gaps.md).
STUB="$REPO/docs/engine-patch/apply-engine-stubs-patch.py"
ACC="browser_accessibility_qt.cpp"
CLIP="clipboard_qt.cpp"

if [ -f "$SRC/$ACC" ] && [ -f "$SRC/$CLIP" ]; then
  python3 "$STUB" --check --src "$SRC" >/tmp/engstub.out 2>&1
  src_rc=$?
  if (( src_rc == 0 )) && grep -q "OK: patched" /tmp/engstub.out; then
    ok "the engine source carries the stub implementations (a11y + clipboard)"
  else
    no "the engine stub implementations are not healthy on the real source (rc=$src_rc)"
    sed 's/^/    /' /tmp/engstub.out
  fi

  tmp2="$(mktemp -d)"
  cp "$SRC/$ACC" "$SRC/$CLIP" "$tmp2/"
  python3 "$STUB" --src "$tmp2" --revert >/dev/null 2>&1
  if python3 "$STUB" --check --src "$tmp2" 2>&1 | grep -q "OK: appliable"; then
    ok "a reverted stub copy is appliable - revert restores the original stub text"
  else
    no "a reverted stub copy is not appliable: revert left the source broken"
    python3 "$STUB" --check --src "$tmp2" 2>&1 | sed 's/^/    /'
  fi

  python3 "$STUB" --src "$tmp2" >/dev/null 2>&1
  if python3 "$STUB" --check --src "$tmp2" 2>&1 | grep -q "OK: patched"; then
    ok "applying the stubs patch puts the copy back in the patched state"
  else
    no "applying the stubs patch did not reach the patched state"
  fi

  # drift detection on an UNPATCHED copy (where the anchor is still needed)
  python3 "$STUB" --src "$tmp2" --revert >/dev/null 2>&1
  python3 - "$tmp2/$CLIP" <<'PY'
import pathlib
import sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("ClipboardQt::ReadBookmark", "ClipboardQt::ReadBookmarkRenamed"))
PY
  if python3 "$STUB" --check --src "$tmp2" >/dev/null 2>&1; then
    no "stub anchor drift was NOT detected - a Qt upgrade could silently drop the implementations"
  else
    ok "stub anchor drift is detected (--check fails loudly)"
  fi
  rm -rf "$tmp2"
else
  skip "engine stub sources not present at $SRC"
fi

# ── 5. the BUILD guard refuses a tree the patches cannot be applied to ────────
# build-patched-engine.sh APPLIES both patches and then REQUIRES "OK: patched". That is stronger
# than the --check scripts' exit code, which is 0 for an *appliable* (unpatched) tree - a guard
# that accepted rc 0 would build unpatched code, the exact failure it exists to prevent.
BUILD="$REPO/docs/engine-patch/build-patched-engine.sh"

mk_unpatched() {                       # a scratch dir holding UNPATCHED (appliable) copies
  d="$(mktemp -d)"
  cp "$SRC/$HDR" "$SRC/$IMP" "$SRC/$ACC" "$SRC/$CLIP" "$d/"
  python3 "$SCRIPT" --src "$d" --revert >/dev/null 2>&1
  python3 "$STUB"   --src "$d" --revert >/dev/null 2>&1
  printf '%s' "$d"
}

# (A) unpatched-but-appliable: the guard applies the patches itself and passes.
d="$(mk_unpatched)"
if OMARCHY_ENGINE_SRC="$d" bash "$BUILD" --check-only >/tmp/bg.log 2>&1; then
  ok "the build guard applies the patches and passes on an appliable tree"
else
  no "the build guard failed on an appliable tree (it should apply both patches)"
  sed 's/^/    /' /tmp/bg.log
fi
rm -rf "$d"

# (B) a DRIFTED tree (a Qt upgrade moved the anchor): the guard must REFUSE.
d="$(mk_unpatched)"
python3 - "$d/$HDR" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("SupportsResidentKeys", "SupportsResidentKeysRenamed"))
PY
if OMARCHY_ENGINE_SRC="$d" bash "$BUILD" --check-only >/tmp/bg2.log 2>&1; then
  no "the build guard did NOT refuse a drifted tree - it would build unpatched code"
else
  ok "the build guard refuses a drifted tree (patch cannot be applied)"
fi
rm -rf "$d"

# (C) HALF-patched (patch 1 applied, patch 2 reverted): must not pass - patch 2 was previously
#     unguarded, so a build could silently reintroduce the conditional-autofill hang.
d="$(mk_unpatched)"
python3 "$SCRIPT" --src "$d" >/dev/null 2>&1     # applies patch 1 AND patch 2, both anchors intact
python3 - "$d/$IMP" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
t = p.read_text()
new = "    if (ui_presentation == UIPresentation::kAutofill)\n        ui_presentation = UIPresentation::kModal;\n\n"
assert new in t, "patch 2 body not found on the freshly patched copy"
p.write_text(t.replace(new, "", 1))
PY
if OMARCHY_ENGINE_SRC="$d" bash "$BUILD" --check-only >/dev/null 2>&1; then
  no "the build guard accepted a tree missing patch 2 (the conditional-autofill fix)"
else
  ok "the build guard requires patch 2 as well as patch 1"
fi
rm -rf "$d"

echo "shell: $pass passed, $fail failed"
(( fail == 0 ))

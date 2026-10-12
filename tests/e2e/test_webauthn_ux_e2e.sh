#!/bin/bash
# End-to-end: boot the REAL WebAuthn UX handler against the REAL QtWebEngine, offscreen.
#
# Proves the two things the unit tests cannot: that attach() connects to a real QWebEnginePage
# (the signal qutebrowser never wires), and what the engine actually answers for
# isUserVerifyingPlatformAuthenticatorAvailable() - the capability whose "false" made every
# sign-in page hang. No display and no security key are needed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${OMARCHY_E2E_PYTHON:-/usr/bin/python3}"
export QT_QPA_PLATFORM=offscreen

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS: $1"; }
no() { fail=$((fail + 1)); echo "  FAIL: $1"; }
skip() { echo "  SKIP: $1"; }

out="$("$PY" "$REPO/tests/e2e/webauthn_ux_driver.py" 2>/dev/null)"
rc=$?
if (( rc != 0 )); then
  echo "  FAIL: the e2e driver exited $rc"
  echo "$out" | sed 's/^/    /'
  echo "e2e: 0 passed, 1 failed"
  exit 1
fi

has() { printf '%s\n' "$out" | grep -q "E2E $1=$2"; }

if has ATTACH ok; then ok "attach() connects the handler to a real QWebEnginePage"; else no "attach() did not connect"; fi
if has DRIVE ok; then ok "the handler drives CollectPin and SelectAccount on the real event loop"; else no "the state machine was not driven"; fi
if has TOUCH ok; then ok "the touch-your-key notice is shown"; else no "no touch notice"; fi
if has DONE ok; then ok "a completed ceremony is announced"; else no "completion was not announced"; fi
if has PINMSG ok; then ok "the PIN dialog reflects the last error and attempts left"; else no "the PIN message ignored the error/attempts"; fi

uvpa="$(printf '%s\n' "$out" | sed -n 's/^E2E UVPA=//p')"
case "$uvpa" in
  true)  ok "the engine reports a platform authenticator (patched qt6-webengine)";;
  false) skip "engine reports no platform authenticator - the engine patch (~/Work/qt6-webengine-build) is not installed here; sign-in still needs it";;
  nofn)  no "the engine exposes no WebAuthn capability question at all";;
  *)     no "unexpected capability answer: $uvpa";;
esac

echo "e2e: $pass passed, $fail failed"
(( fail == 0 ))

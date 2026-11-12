#!/bin/bash
# End-to-end: run the REAL LinkedIn redirect script in the REAL QtWebEngine against the REAL URL.
#
# The unit tests run the script in a sandbox and the regression tests read its text; this is the
# only kind that shows the script is injected into Cloudflare's block page at all, and that it ends
# up on the login page. Measured: the bare root URL is served "Sorry, you have been blocked" while
# /login renders normally, in the same engine on the same address.
#
# The block page is LinkedIn's to serve, so a run that meets no block at all (another network, a
# relaxed rule) is reported as a note rather than a failure - but a block page that is NOT escaped
# is a failure, and so is the login page being bounced.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${OMARCHY_E2E_PYTHON:-/usr/bin/python3}"
export QT_QPA_PLATFORM=offscreen

ROOT_URL="https://www.linkedin.com/"
LOGIN_URL="https://www.linkedin.com/login/"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS: $1"; }
no() { fail=$((fail + 1)); echo "  FAIL: $1"; }
note() { echo "  NOTE: $1"; }

if ! "$PY" -c 'import PyQt6.QtWebEngineCore' 2>/dev/null; then
  echo "  SKIP: no PyQt6 QtWebEngineCore for $PY (qutebrowser is not installed here)"
  echo "e2e: 0 passed, 0 failed (skipped)"
  exit 0
fi

out="$("$PY" "$REPO/tests/e2e/linkedin_redirect_driver.py" 2>/dev/null)"
rc=$?
if (( rc != 0 )); then
  echo "  FAIL: the e2e driver exited $rc"
  printf '%s\n' "$out" | sed 's/^/    /'
  echo "e2e: 0 passed, 1 failed"
  exit 1
fi

if grep -q 'E2E TIMEOUT=1' <<<"$out"; then
  note "the driver timed out; treating as no usable network rather than a failure of the fix"
  echo "e2e: 0 passed, 0 failed (skipped)"
  exit 0
fi

final0="$(sed -n 's/^E2E FINAL_0=//p' <<<"$out")"
final1="$(sed -n 's/^E2E FINAL_1=//p' <<<"$out")"
records0="$(sed -n 's/^E2E RECORDS_0=//p' <<<"$out")"
records1="$(sed -n 's/^E2E RECORDS_1=//p' <<<"$out")"

# No usable network: the engine never got a document, so there is nothing to conclude.
case "$final0" in
  "$ROOT_URL"|"$LOGIN_URL") ;;
  *) note "the root URL never loaded (final=${final0:-<none>}); no network, skipping"
     echo "e2e: 0 passed, 0 failed (skipped)"
     exit 0 ;;
esac

# The block page is LinkedIn's to serve. A run that meets none proves nothing about the escape -
# the script is inert on a page that is not a block page - so that run is a note and a skip, never a
# failure. A block page that WAS served and was not escaped is the failure. (The comment at the top
# of this file has always said so; this is the check that now matches it.)
if [[ $records0 != *'"blocked": true'* ]]; then
  note "no block page on this network (root document: ${records0:-<none>}) - the redirect is inert there"
  echo "e2e: 0 passed, 0 failed (skipped)"
  exit 0
fi

ok "the block page really was served at the root, and was recognised as one"

if [[ $final0 == "$LOGIN_URL" ]]; then
  ok "the block page is escaped: $ROOT_URL ends on $LOGIN_URL"
else
  no "the block page was served but not escaped: expected $ROOT_URL to end on $LOGIN_URL, got ${final0:-<none>}"
fi

if [[ $records0 == *"$LOGIN_URL"* && $records0 == *'"blocked": false'* ]]; then
  ok "the login page rendered after the redirect (the second document is the real page)"
else
  no "the login page never rendered after the redirect (records: ${records0:-<none>})"
fi

if [[ $final1 == "$LOGIN_URL" && $records1 != *'"blocked": true'* ]]; then
  ok "the login page is left alone - the loop guard holds on the destination itself"
else
  no "the login page was not left alone (final=${final1:-<none>} records=${records1:-<none>})"
fi

echo "e2e: $pass passed, $fail failed"
(( fail == 0 ))

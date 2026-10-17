#!/bin/bash
# End-to-end: every filter-list URL config.py configures must actually resolve.
#
# A dead list URL is not a test failure anywhere else — qutebrowser reports it only as a
# 404 in the status bar during :adblock-update, which is how two bad URLs shipped. This
# fetches them for real. It SKIPS when the network itself is unreachable (nothing is
# wrong with the URLs then), and fails on a 4xx that means the list is gone.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${OMARCHY_E2E_PYTHON:-/usr/bin/python3}"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS: $1"; }
no() { fail=$((fail + 1)); echo "  FAIL: $1"; }

out="$("$PY" "$REPO/tests/e2e/blocking_urls_driver.py" 2>/dev/null)"
rc=$?

if (( rc != 0 )); then
  echo "  FAIL: the url-check driver exited $rc"
  echo "e2e: 0 passed, 1 failed"
  exit 1
fi

if [[ $out == *OFFLINE=1* ]]; then
  echo "  SKIP: no network here, so the list URLs cannot be checked"
  echo "e2e: 0 passed, 0 failed (skipped)"
  exit 0
fi

checked=0
while read -r _tag code url; do
  [[ $_tag == URL ]] || continue
  checked=$((checked + 1))
  case $code in
    404|410) no "list is GONE (HTTP $code): $url";;
    4??)     no "list rejects the fetch (HTTP $code): $url";;
    2??|3??) pass=$((pass + 1));;
    000)     no "no response from $url";;
    *)       no "unexpected HTTP $code for $url";;
  esac
done <<< "$out"

if (( checked == 0 )); then
  no "no list URLs were checked"
elif (( fail == 0 )); then
  ok "all $checked configured list URLs resolve"
fi

echo "e2e: $pass passed, $fail failed"
(( fail == 0 ))

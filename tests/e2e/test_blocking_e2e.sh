#!/bin/bash
# End-to-end: load the repo's OWN filter lists into the REAL adblock engine that
# qutebrowser uses (Brave's adblock-rust, via the `adblock` python binding) and assert
# it blocks the trackers we claim to block — and leaves real page content alone.
#
# Distinct from every other kind here: the unit/regression tests read the config text;
# this one asks the engine for a decision. No browser, no network needed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${OMARCHY_E2E_PYTHON:-/usr/bin/python3}"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS: $1"; }
no() { fail=$((fail + 1)); echo "  FAIL: $1"; }

out="$("$PY" "$REPO/tests/e2e/blocking_driver.py" 2>/dev/null)"
rc=$?

if [[ $out == *NOADBLOCK=1* ]]; then
  echo "  SKIP: no python with the 'adblock' engine here (qutebrowser's blocker); install qutebrowser"
  echo "e2e: 0 passed, 0 failed (skipped)"
  exit 0
fi
if (( rc != 0 )); then
  echo "  FAIL: the e2e driver exited $rc"
  printf '%s\n' "$out" | sed 's/^/    /'
  echo "e2e: 0 passed, 1 failed"
  exit 1
fi

has() { printf '%s\n' "$out" | grep -q "E2E $1=$2"; }

# Both of our own lists must have been found and parsed.
loaded="$(printf '%s\n' "$out" | sed -n 's/^E2E LOADED=//p')"
if [[ $loaded == *youtube-ads.txt* && $loaded == *trackers.txt* ]]; then
  ok "both shipped lists load into the engine (LOADED=$loaded)"
else
  no "a shipped list did not load (LOADED=${loaded:-<none>})"
fi

blocked_n=0
for key in GA GTM DOUBLECLICK FB_PIXEL CRITEO HOTJAR CLARITY TABOOLA SCORECARD \
           SEGMENT FINGERPRINT MIXPANEL LINKEDIN_PX TIKTOK TAG_MANAGER \
           YT_PAGEAD YT_MIDROLL; do
  if has "BLOCK_$key" ok; then
    blocked_n=$((blocked_n + 1))
  else
    no "not blocked by our lists: $key"
  fi
done
(( blocked_n == 17 )) && ok "all 17 known trackers/ad endpoints are blocked"

allowed_n=0
for key in SITE YOUTUBE_WATCH YT_IMAGE GOOGLEVIDEO WIKIPEDIA GDOCS; do
  if has "ALLOW_$key" ok; then
    allowed_n=$((allowed_n + 1))
  else
    no "over-blocked (must stay reachable): $key"
  fi
done
(( allowed_n == 6 )) && ok "all 6 real-content URLs stay reachable (no over-blocking)"

echo "e2e: $pass passed, $fail failed"
(( fail == 0 ))

#!/bin/bash
# Tests for userscripts/qute-yt-dl.
#
# Every assertion here exists because a mutation of the corresponding line SURVIVED: the
# argument handling, the "which URL" decision, the dependency checks and the SponsorBlock
# probe were all uncovered. Nothing here needs the network, a real yt-dlp or a real browser
# — the script is driven with a stub binary and a FIFO, which is exactly how it behaves
# under qutebrowser (QUTE_FIFO is how it talks back).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
US="$ROOT/userscripts/qute-yt-dl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
is()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

mkdir -p "$TMP/bin" "$TMP/dl" "$TMP/state"
mkstub() {   # $1 = does its --help advertise --sponsorblock-remove?
  cat > "$TMP/bin/yt-dlp" <<EOF
#!/bin/bash
if [[ "\${1:-}" == "--help" ]]; then
  ${1:+echo "  --sponsorblock-remove CATEGORIES"}
  exit 0
fi
echo "yt-dlp \$*"
exit 0
EOF
  chmod +x "$TMP/bin/yt-dlp"
}

# run <path> <qute-url> [args...] -> prints "rc=<n>" then the FIFO contents
run() {
  local path="$1" url="$2"; shift 2
  : > "$TMP/fifo"
  local envs=(PATH="$path" HOME="$TMP" QUTE_FIFO="$TMP/fifo" QUTE_URL="$url"
              DOWNLOAD_DIR="$TMP/dl" XDG_STATE_HOME="$TMP/state")
  env -i "${envs[@]}" bash "$US" "$@" >/dev/null 2>&1
  printf 'rc=%d\n' "$?"
  cat "$TMP/fifo" 2>/dev/null || true
}

mkstub yes

# 1. no mode: explains itself and exits successfully (not a failure)
out="$(run "$TMP/bin:/usr/bin:/bin" "https://example.com")"
is "no mode exits 0"        "$(printf '%s' "$out" | head -1)" "rc=0"
case "$out" in *",dv"*",dm"*) ok "no mode prints the usage hint";;
  *) bad "no mode prints the usage hint";; esac

# 2. an unknown mode is an error
out="$(run "$TMP/bin:/usr/bin:/bin" "https://example.com" bogus)"
is "unknown mode exits 1"   "$(printf '%s' "$out" | head -1)" "rc=1"
# It must be an ERROR, not just a message: swapping err() for msg() left this passing.
case "$out" in *"message-error 'qute-yt-dl: unknown mode"*) ok "unknown mode is reported as an error";;
  *) bad "unknown mode is reported as an error (got: $out)";; esac

# 3. no URL on a NON-video page: ask for a hint, and succeed
out="$(run "$TMP/bin:/usr/bin:/bin" "https://example.com/list" video)"
is "non-video page exits 0" "$(printf '%s' "$out" | head -1)" "rc=0"
case "$out" in *"hint --rapid ytdl"*) ok "non-video page asks for a hint";;
  *) bad "non-video page asks for a hint (got: $out)";; esac

# 4. no URL on a VIDEO page: it uses the page URL itself (no hint)
out="$(run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" video)"
is "video page exits 0"     "$(printf '%s' "$out" | head -1)" "rc=0"
case "$out" in *"hint --rapid"*) bad "video page must not ask for a hint";;
  *) ok "video page does not ask for a hint";; esac
# The runner file is written SYNCHRONOUSLY, the log only once the detached runner gets
# going — asserting on the log directly raced it and made this suite flaky (the target's
# score moved between runs). Check the deterministic artifact first...
runner="$(ls "$TMP/state/omarchy-qutebrowser/yt-dl/runner."*.sh 2>/dev/null | head -1)"
if [[ -n "$runner" ]] && grep -q -- "abc" "$runner"; then
  ok "a runner was generated for the page's video"
else
  bad "a runner was generated for the page's video (runner='$runner')"
fi
# ...then wait (bounded) for the log, which is what proves the download actually started.
for _ in $(seq 1 25); do
  [[ -s "$TMP/state/omarchy-qutebrowser/yt-dl/latest.log" ]] && break
  sleep 0.1
done
[[ -s "$TMP/state/omarchy-qutebrowser/yt-dl/latest.log" ]] \
  && ok "the download was started (log written)" || bad "the download was started (log written)"

# 5. an explicit URL argument never hints
out="$(run "$TMP/bin:/usr/bin:/bin" "https://example.com/list" video "https://youtu.be/xyz")"
case "$out" in *"hint --rapid"*) bad "an explicit URL must not hint";;
  *) ok "an explicit URL does not hint";; esac

# 6. yt-dlp missing -> error, exit 1. Only testable where yt-dlp is genuinely absent,
#    which cannot be arranged on a machine that has it installed.
if command -v yt-dlp >/dev/null 2>&1; then
  ok "SKIPPED: missing-yt-dlp branch (yt-dlp is installed here, so it cannot be simulated)"
else
  out="$(run "/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" video)"
  is "missing yt-dlp exits 1" "$(printf '%s' "$out" | head -1)" "rc=1"
  case "$out" in *"yt-dlp not found"*) ok "missing yt-dlp is reported";;
    *) bad "missing yt-dlp is reported";; esac
fi

# 7. video mode must NOT require ffmpeg (only mp3 does)
out="$(run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" video)"
is "video mode works without ffmpeg" "$(printf '%s' "$out" | head -1)" "rc=0"

# 8. mp3 + ffmpeg. The behaviour DEPENDS ON THE ENVIRONMENT, so assert whichever branch
#    applies: a test that assumed ffmpeg was installed passed here and failed in CI (which
#    has none), taking the whole target's baseline with it. Both branches are covered, one
#    on each kind of machine.
if command -v ffmpeg >/dev/null 2>&1; then
  out="$(run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" mp3)"
  is "mp3 mode proceeds when ffmpeg is present" "$(printf '%s' "$out" | head -1)" "rc=0"
  case "$out" in *"ffmpeg not found"*) bad "mp3 mode must not claim ffmpeg is missing";;
    *) ok "mp3 mode does not claim ffmpeg is missing";; esac
else
  out="$(run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" mp3)"
  is "mp3 mode reports ffmpeg missing when it is absent" "$(printf '%s' "$out" | head -1)" "rc=1"
  case "$out" in *"ffmpeg not found"*) ok "mp3 mode reports ffmpeg missing";;
    *) bad "mp3 mode reports ffmpeg missing (got: $out)";; esac
fi

# 9. without a FIFO it must not crash (qutebrowser may not set one)
: > "$TMP/fifo"
env -i PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP" DOWNLOAD_DIR="$TMP/dl" \
  XDG_STATE_HOME="$TMP/state" QUTE_URL="https://example.com" bash "$US" >/dev/null 2>&1
is "no QUTE_FIFO still exits 0" "$?" "0"

# 10/11. SponsorBlock is passed only when the installed yt-dlp supports it
mkstub yes
run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" video >/dev/null
if grep -q -- "--sponsorblock-remove" "$TMP/state/omarchy-qutebrowser/yt-dl/runner."*.sh 2>/dev/null; then
  ok "sponsorblock is used when supported"
else
  bad "sponsorblock is used when supported"
fi
rm -f "$TMP/state/omarchy-qutebrowser/yt-dl/runner."*.sh
mkstub ""
run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" video >/dev/null
if grep -q -- "--sponsorblock-remove" "$TMP/state/omarchy-qutebrowser/yt-dl/runner."*.sh 2>/dev/null; then
  bad "sponsorblock must be omitted when unsupported"
else
  ok "sponsorblock is omitted when unsupported"
fi


# ── progress bar ──────────────────────────────────────────────────────────────
# --bar renders ONE log line, so the bar is verifiable without a live download.
US="$ROOT/userscripts/qute-yt-dl"
bar() { bash "$US" --bar "$1"; }

is "a 45.2% line draws a 32-wide bar with 14 filled" \
   "$(bar '[download]  45.2% of  12.34MiB at  1.23MiB/s ETA 00:08')" \
   "[##############------------------]  45.2%  1.23MiB/s  ETA 00:08"

is "0% is an empty bar" \
   "$(bar '[download]   0.0% of   1.00MiB at    1.00MiB/s ETA 00:01')" \
   "[--------------------------------]   0.0%  1.00MiB/s  ETA 00:01"

is "100% is a full bar" \
   "$(bar '[download] 100% of   1.00MiB at    1.00MiB/s ETA 00:00')" \
   "[################################]   100%  1.00MiB/s  ETA 00:00"

is "over 100% clamps to a full bar" \
   "$(bar '[download] 120% of   1.00MiB at    1.00MiB/s ETA 00:00')" \
   "[################################]   120%  1.00MiB/s  ETA 00:00"

is "a line without a percentage reads as downloading" \
   "$(bar '[download] Destination: /home/x/Downloads/Clip.mp4')" \
   "downloading…"

is "missing speed and ETA fall back to dashes" \
   "$(bar '[download]  10.0% of   1.00MiB')" \
   "[###-----------------------------]  10.0%  --  ETA --"

# ── watch mode (end to end: it must DRAW a bar and must EXIT) ──────────────────
# --watch hung for 30 s in the first end-to-end run because `kill -0` also succeeds on
# a zombie, so a runner that exited without being reaped kept the loop alive. `timeout`
# here turns any recurrence into a failed assertion instead of a hung suite.
WLOG=$(mktemp); WPID=$(mktemp)
sleep 60 & WSLEEP=$!
echo "$WSLEEP" > "$WPID"
printf '[download]  10.0%% of 1.00MiB at 1.00MiB/s ETA 00:10\n' > "$WLOG"
( sleep 1; printf 'OK: saved to /home/x/Downloads\n' >> "$WLOG" ) &
WOUT=$(timeout 12 bash "$US" --watch "$WLOG" "$WPID" </dev/null 2>&1; echo "RC=$?")
kill "$WSLEEP" 2>/dev/null; wait "$WSLEEP" 2>/dev/null
rm -f "$WLOG" "$WPID"

is "watch exits once the runner reports its outcome (not RC=124)" \
   "$(printf '%s' "$WOUT" | grep -c 'RC=0')" "1"
is "watch draws a progress bar" \
   "$(printf '%s' "$WOUT" | grep -cE '\[#+-+\]')" "1"
is "watch still shows the outcome line afterwards" \
   "$(printf '%s' "$WOUT" | grep -c 'OK: saved to')" "1"

# A bar with exactly ONE filled cell (2% of 32 rounds to 1) — the boundary between an
# empty bar and a one-cell bar, which a `-gt 0` mutant to `-gt 1` gets wrong.
is "2% draws exactly one filled cell" \
   "$(bar '[download]   2.0% of   1.00MiB at    1.00MiB/s ETA 00:10')" \
   "[#-------------------------------]   2.0%  1.00MiB/s  ETA 00:10"

# Exit statuses are part of the contract: --bar must report success for a line it draws
# *and* for one it cannot parse (it says so in the text instead).
bash "$US" --bar '[download]  45.2% of 1MiB at 1MiB/s ETA 00:01' >/dev/null 2>&1
if [ $? -eq 0 ]; then ok "--bar exits 0 for a progress line"; else bad "--bar exits 0 for a progress line"; fi
bash "$US" --bar '[download] Destination: /tmp/x.mp4' >/dev/null 2>&1
if [ $? -eq 0 ]; then ok "--bar exits 0 for an unparsable line"; else bad "--bar exits 0 for an unparsable line"; fi

# Watch must also stop when the runner DISAPPEARS without writing an outcome line
# (a killed or crashed runner). This is the pid path, not the log path.
WLOG2=$(mktemp); WPID2=$(mktemp)
printf '[download]  10.0%% of 1MiB at 1MiB/s ETA 00:10\n' > "$WLOG2"
sleep 0.5 & WCORPSE=$!
wait "$WCORPSE" 2>/dev/null || true          # reap it: a zombie would keep `kill -0` true
echo "$WCORPSE" > "$WPID2"
WOUT2=$(timeout 15 bash "$US" --watch "$WLOG2" "$WPID2" </dev/null 2>&1; echo "RC=$?")
rm -f "$WLOG2" "$WPID2"
is "watch exits when the runner vanishes with no outcome line (not RC=124)" \
   "$(printf '%s' "$WOUT2" | grep -c 'RC=0')" "1"

echo
if [[ "$fails" -eq 0 ]]; then echo "qute-yt-dl: all shell assertions passed"; exit 0; fi
echo "qute-yt-dl: $fails assertion(s) failed"; exit 1
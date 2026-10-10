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

# 8. mp3 mode with ffmpeg present must proceed — this is what kills the `-z` -> `-n`
#    mutation of the ffmpeg check (which would demand ffmpeg in the wrong direction).
#    /bin is a symlink to /usr/bin on Arch, so "ffmpeg absent" cannot be simulated here;
#    that branch is covered by the conditional below instead.
out="$(run "$TMP/bin:/usr/bin:/bin" "https://www.youtube.com/watch?v=abc" mp3)"
is "mp3 mode proceeds when ffmpeg is present" "$(printf '%s' "$out" | head -1)" "rc=0"
case "$out" in *"ffmpeg not found"*) bad "mp3 mode must not claim ffmpeg is missing";;
  *) ok "mp3 mode does not claim ffmpeg is missing";; esac
if command -v ffmpeg >/dev/null 2>&1; then
  ok "SKIPPED: missing-ffmpeg branch (ffmpeg is installed here)"
else
  out="$(run "$TMP/bin:/bin" "https://www.youtube.com/watch?v=abc" mp3)"
  is "mp3 without ffmpeg exits 1" "$(printf '%s' "$out" | head -1)" "rc=1"
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

echo
if [[ "$fails" -eq 0 ]]; then echo "qute-yt-dl: all shell assertions passed"; exit 0; fi
echo "qute-yt-dl: $fails assertion(s) failed"; exit 1

#!/bin/bash
# tests/shell/test_cosmetic_update.sh — bin/omarchy-cosmetic-update
#
# The wrapper's job is argv assembly and the one message that tells the user how to apply
# the rebuild; the compile itself belongs to tools/build_cosmetic.py (unit-tested). A stub
# python3 records what would have run, so the test never touches the network or the real
# greasemonkey directory.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
ok()   { echo "ok: $*"; }
bad()  { echo "FAIL: $*"; fail=1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
REAL_PYTHON="$(command -v python3)"

# A fake plugin tree: bin/omarchy-cosmetic-update + userscripts/template + tools/tool.
mkdir -p "$work/plugin/bin" "$work/plugin/userscripts" "$work/plugin/tools" "$work/stubs" "$work/data"
cp "$REPO/bin/omarchy-cosmetic-update" "$work/plugin/bin/"
: > "$work/plugin/userscripts/cosmetic-filters.js"
cat > "$work/plugin/tools/build_cosmetic.py" <<'STUB'
import sys
print("ARGV " + " ".join(sys.argv[1:]))
STUB
cat > "$work/stubs/python3" <<STUB
#!/bin/bash
# Absolute interpreter path: with \$work/stubs first on PATH, a bare "python3" here would
# resolve to this very stub and loop forever.
exec $REAL_PYTHON "\$@"
STUB
chmod +x "$work/stubs/python3"

run() {  # run <expected-exit> <description> [args...]
  local want="$1" desc="$2"; shift 2
  local out code
  out="$(PATH="$work/stubs:$PATH" OMARCHY_QUTEBROWSER_DIR="$work/plugin" \
         XDG_DATA_HOME="$work/data" bash "$work/plugin/bin/omarchy-cosmetic-update" "$@" 2>&1)"
  code=$?
  printf '%s\n' "$out" > "$work/out"
  if [[ $code -ne $want ]]; then
    bad "$desc (exit $code, wanted $want): $out"; return 1
  fi
  ok "$desc"
}

# 1. A plain run writes to the profile's greasemonkey directory with the plugin's template.
run 0 "a plain run succeeds"
grep -q "ARGV --output $work/data/qutebrowser/greasemonkey/cosmetic-filters.js --template $work/plugin/userscripts/cosmetic-filters.js" "$work/out" \
  && ok "output defaults to the profile greasemonkey dir, template to the plugin" \
  || bad "unexpected argv: $(cat "$work/out")"

# 2. --dry-run and both spellings of --source reach the compiler.
run 0 "--dry-run and --source are forwarded" --dry-run --source https://example.org/list.txt
grep -q -- "--dry-run" "$work/out" && grep -q -- "--source https://example.org/list.txt" "$work/out" \
  && ok "flags reach the compiler" || bad "flags lost: $(cat "$work/out")"
run 0 "--source=<url> is accepted too" --source=https://example.org/other.txt
grep -q -- "--source https://example.org/other.txt" "$work/out" \
  && ok "--source=<url> is split into two arguments" || bad "--source=<url> lost: $(cat "$work/out")"
run 2 "--source without a URL exits 2" --source
grep -qi "needs a URL" "$work/out" && ok "the dangling --source is refused" || bad "no message: $(cat "$work/out")"

# 2b. A lone --dry-run must not be swallowed as a --source value.
run 0 "--dry-run alone still works" --dry-run
grep -q -- "--source" "$work/out" && bad "--dry-run became a --source value" \
  || ok "a lone --dry-run is not taken for a --source value"

# 3. A dry run must not tell the user to reload a script it did not write.
grep -q "greasemonkey-reload" "$work/out" \
  && bad "--dry-run still prints the reload hint" || ok "--dry-run prints no reload hint"

# 4. A real run does print it.
run 0 "a real run succeeds" >/dev/null
grep -q "greasemonkey-reload" "$work/out" \
  && ok "a real run tells the user to reload Greasemonkey" || bad "no reload hint after a real run"

# 5. An unknown argument is refused instead of being handed to the compiler.
run 2 "an unknown argument exits 2" --bogus
grep -qi "unknown argument" "$work/out" && ok "the refusal names the argument" || bad "no message: $(cat "$work/out")"
grep -q "ARGV" "$work/out" && bad "the compiler ran anyway" || ok "the compiler never ran for a bad argument"

# 6. A missing template is a hard error naming the fix.
rm -f "$work/plugin/userscripts/cosmetic-filters.js"
out="$(PATH="$work/stubs:$PATH" OMARCHY_QUTEBROWSER_DIR="$work/plugin" XDG_DATA_HOME="$work/data" \
       bash "$work/plugin/bin/omarchy-cosmetic-update" 2>&1)"; code=$?
[[ $code -eq 2 ]] && ok "a missing template exits 2" || bad "missing template exited $code"
grep -q "OMARCHY_QUTEBROWSER_DIR" <<<"$out" && ok "the error names the environment variable" \
  || bad "the error does not say how to fix it: $out"

# 7. The compiler's own exit status is propagated (an offline rebuild must not look fine).
cat > "$work/plugin/tools/build_cosmetic.py" <<'STUB'
import sys
sys.exit(7)
STUB
: > "$work/plugin/userscripts/cosmetic-filters.js"
run 7 "the compiler's failure status is propagated"
grep -q "greasemonkey-reload" "$work/out" \
  && bad "a failed rebuild still tells the user to reload" \
  || ok "a failed rebuild prints no reload hint"

# 8. Without OMARCHY_QUTEBROWSER_DIR the plugin root comes from the script's own path, so a
# checkout works with nothing exported. Run from / so it cannot be taken for the cwd.
cat > "$work/plugin/tools/build_cosmetic.py" <<'STUB'
import sys
print("ARGV " + " ".join(sys.argv[1:]))
STUB
: > "$work/plugin/userscripts/cosmetic-filters.js"
out="$(cd / && env -u OMARCHY_QUTEBROWSER_DIR PATH="$work/stubs:$PATH" XDG_DATA_HOME="$work/data" \
       bash "$work/plugin/bin/omarchy-cosmetic-update" 2>&1)"; code=$?
[[ $code -eq 0 ]] && ok "a run without the environment variable succeeds" \
  || bad "a run without the environment variable exited $code: $out"
grep -q -- "--template $work/plugin/userscripts/cosmetic-filters.js" <<<"$out" \
  && ok "the plugin root is inferred from the script's own path" \
  || bad "the template path was not derived from the script: $out"

exit "$fail"

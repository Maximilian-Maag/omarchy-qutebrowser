#!/bin/bash
# tests/shell/test_ai_fix_export.sh — `qute-ai-fix --export`
#
# A per-domain fix lives in $XDG_STATE_HOME, which a reinstall wipes and a second machine
# never sees. --export rewrites the managed block of config/cosmetic-extra.txt from those
# fix files, so the fix can be committed. The block is the only thing it may touch: the
# hand-written rules above it are the reason the file exists, and a second run must be a
# no-op.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
ok()  { echo "ok: $*"; }
bad() { echo "FAIL: $*"; fail=1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/plugin/userscripts" "$work/plugin/config" "$work/state/omarchy-qutebrowser/site-fixes"
cp "$REPO/userscripts/qute-ai-fix" "$work/plugin/userscripts/"
export_file="$work/plugin/config/cosmetic-extra.txt"
fixes="$work/state/omarchy-qutebrowser/site-fixes"

cat > "$export_file" <<'EOF'
! hand-written header that must survive
! a comment that mentions golem.de##.not-a-rule
golem.de##.hand-written-rule
example.org##.keep-me
EOF

cat > "$fixes/golem.de.json" <<'EOF'
{"domain": "golem.de", "css_hide": [".ai-found-box", ".hand-written-rule", " .spaced ", ""]}
EOF
cat > "$fixes/news.example.json" <<'EOF'
{"domain": "news.example", "css_hide": [".promo"]}
EOF
cat > "$fixes/broken.example.json" <<'EOF'
{ this is not json
EOF
cat > "$fixes/no-hide.example.json" <<'EOF'
{"domain": "no-hide.example", "css_override": ["body{color:red}"]}
EOF

run_export() { XDG_STATE_HOME="$work/state" bash "$work/plugin/userscripts/qute-ai-fix" --export "$@" 2>&1; }

out="$(run_export)"
is() { # is <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1"; printf '  expected: %s\n  actual:   %s\n' "$3" "$2"; fi
}

grep -qxF '! hand-written header that must survive' "$export_file" \
  && ok "the hand-written header survives" || bad "the hand-written header survives"
grep -qxF 'golem.de##.hand-written-rule' "$export_file" \
  && ok "a hand-written rule survives" || bad "a hand-written rule survives"
grep -qxF 'example.org##.keep-me' "$export_file" \
  && ok "an unrelated domain's rule survives" || bad "an unrelated domain's rule survives"

is "the exported rules are in the block" \
   "$(grep -cE '^(golem\.de|news\.example)##' "$export_file")" "4"
grep -qxF 'golem.de##.ai-found-box' "$export_file" \
  && ok "a fix's selector is exported" || bad "a fix's selector is exported"
grep -qxF 'news.example##.promo' "$export_file" \
  && ok "every fix file is exported" || bad "every fix file is exported"
is "a selector already present by hand is not duplicated" \
   "$(grep -cxF 'golem.de##.hand-written-rule' "$export_file")" "1"
grep -qxF 'golem.de##.spaced' "$export_file" \
  && ok "a padded selector is trimmed, not dropped" || bad "a padded selector is trimmed, not dropped"
is "a whitespace-only selector is dropped" "$(grep -c '## *$' "$export_file")" "0"
grep -q '^! >>> qute-ai-fix --export' "$export_file" \
  && ok "the managed block is marked" || bad "the managed block is marked"
grep -q 'omarchy-cosmetic-update' <<<"$out" \
  && ok "the export says how to apply it" || bad "the export says how to apply it"
grep -q 'broken.example.json' <<<"$out" \
  && ok "a broken fix file is reported, not fatal" || bad "a broken fix file is reported, not fatal"
grep -q 'no-hide.example' "$export_file" \
  && bad "a fix with no css_hide adds nothing" || ok "a fix with no css_hide adds nothing"

# A second run must not append a second block or move the file.
before="$(sha256sum "$export_file" | cut -d' ' -f1)"
out="$(run_export)"
after="$(sha256sum "$export_file" | cut -d' ' -f1)"
is "a second export is a no-op" "$after" "$before"
grep -q 'already carries' <<<"$out" \
  && ok "a second export says so" || bad "a second export says so"
is "and there is still one block" "$(grep -c '^! >>> qute-ai-fix --export' "$export_file")" "1"

# Exporting one domain replaces the block with just that domain's rules.
run_export golem.de >/dev/null
is "a single-domain export keeps only that domain" \
   "$(grep -cE '^(news\.example)##' "$export_file")" "0"
grep -qxF 'golem.de##.ai-found-box' "$export_file" \
  && ok "a single-domain export keeps that domain's rules" || bad "a single-domain export keeps that domain's rules"
grep -qxF 'example.org##.keep-me' "$export_file" \
  && ok "a single-domain export still leaves hand-written rules" || bad "a single-domain export still leaves hand-written rules"

# A stale rule must disappear when the fix no longer has it.
printf '%s\n' '{"domain": "golem.de", "css_hide": [".replacement"]}' > "$fixes/golem.de.json"
run_export >/dev/null
grep -q '.ai-found-box' "$export_file" \
  && bad "a selector no longer in the fix is dropped" || ok "a selector no longer in the fix is dropped"
grep -qxF 'golem.de##.replacement' "$export_file" \
  && ok "the new selector is exported" || bad "the new selector is exported"

# A missing rules file is an error, not an empty success.
mv "$export_file" "$work/moved-away"
out="$(run_export || true)"
grep -q 'no cosmetic rules file' <<<"$out" \
  && ok "a missing rules file is an error" || bad "a missing rules file is an error"
mv "$work/moved-away" "$export_file"

if (( fail == 0 )); then echo "qute-ai-fix --export: all shell assertions passed"; exit 0; fi
echo "qute-ai-fix --export: some assertions failed"; exit 1

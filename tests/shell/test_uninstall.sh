#!/bin/bash
# Tests for install.sh --uninstall.
#
# --uninstall promises to reverse an install and to touch NOTHING else, so the only
# honest test is a real round trip: install into a throwaway HOME, let the user's own
# config sit in the way, then uninstall and diff the whole tree before against after.
# Nothing here reaches the real HOME: install.sh is pointed at a mktemp tree and its
# privileged and desktop tools (sudo, omarchy, xdg-settings, xdg-mime) are stubs, so
# the system-wide step is a no-op and the MIME registrations land in the sandbox.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
SNAP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$SNAP"' EXIT
fails=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
is()  { if [[ $2 == "$3" ]]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# ── the sandbox ───────────────────────────────────────────────────────────────
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/config"
export XDG_DATA_HOME="$TMP/data"
export XDG_STATE_HOME="$TMP/state"
export XDG_SANDBOX_STATE="$TMP/xdg"          # where the xdg-settings stub keeps its value
STUBS="$TMP/stubs"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" \
         "$XDG_SANDBOX_STATE" "$STUBS"
export PATH="$STUBS:$PATH"

QUTE_CONFIG="$XDG_CONFIG_HOME/qutebrowser"
QUTE_DATA="$XDG_DATA_HOME/qutebrowser"
GREASEMONKEY="$QUTE_DATA/greasemonkey"
DATA_USERSCRIPTS="$QUTE_DATA/userscripts"
HOOK_DIR="$XDG_CONFIG_HOME/omarchy/hooks/theme-set.d"
STATE="$XDG_STATE_HOME/omarchy-qutebrowser"
QUTE_DESKTOP="org.qutebrowser.qutebrowser.desktop"

# The artifacts the docs say install adds. Written out here rather than read from
# install.sh: this is the spec the uninstall is checked against, not an echo of it.
CONFIG_MODULES=(config.py themes.py site-overrides.py omarchy_webauthn.py omarchy_crashguard.py)
GREASEMONKEY_SCRIPTS=(
  youtube-adblock.js
  cookie-banner-remover.js
  omarchy-google-signin-chrome-identity.js
  omarchy-ms-signin-chrome-identity.js
  omarchy-chrome-identity.js
  omarchy-linkedin-root-redirect.js
)
USERSCRIPTS=(qute-yt-dl qute-keepassxc-setup qute-keepassxc-fill qute-zoom qute-ai-fix qute-reader)

# ── stubs ─────────────────────────────────────────────────────────────────────
# `omarchy pkg add` installs nothing, `theme current` names a theme, and
# `hook install` does what the real one does: symlink the file into theme-set.d.
cat > "$STUBS/omarchy" <<'STUB'
#!/bin/bash
case "${1:-} ${2:-}" in
  "pkg add") exit 0 ;;
  "theme current") echo "Catppuccin" ;;
  "hook install")
    dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/hooks/theme-set.d"
    mkdir -p "$dir"
    ln -sfn "$4" "$dir/$(basename "$4")"
    ;;
esac
exit 0
STUB

# Never run the real system-default script: it writes /etc.
printf '#!/bin/bash\nexit 0\n' > "$STUBS/sudo"
cp "$STUBS/sudo" "$STUBS/pkexec"

# xdg-settings: one persisted value, exactly the one install reads and writes.
cat > "$STUBS/xdg-settings" <<'STUB'
#!/bin/bash
case "${1:-}" in
  get) [[ -f "$XDG_SANDBOX_STATE/web-browser" ]] && cat "$XDG_SANDBOX_STATE/web-browser" ;;
  set) printf '%s\n' "${3:-}" > "$XDG_SANDBOX_STATE/web-browser" ;;
esac
exit 0
STUB

# xdg-mime: a real [Default Applications] section in mimeapps.list, which is where the
# real tool records a handler — so the uninstall's line-dropping is exercised, not
# simulated away in a side file.
cat > "$STUBS/xdg-mime" <<'STUB'
#!/bin/bash
list="${XDG_CONFIG_HOME:?}/mimeapps.list"
case "${1:-}" in
  query)
    [[ -f $list ]] || exit 0
    line="$(grep -F -- "$3=" "$list" | tail -1)"
    printf '%s\n' "${line#*=}"
    ;;
  default)
    app="$2" mime="$3"
    { [[ -f $list ]] || printf '[Default Applications]\n'
      grep -vF -- "$mime=" "$list"
      printf '%s=%s\n' "$mime" "$app"
    } > "$list.new"
    mv "$list.new" "$list"
    ;;
esac
exit 0
STUB
chmod +x "$STUBS"/*

# ── the user's own state before install ───────────────────────────────────────
mkdir -p "$QUTE_CONFIG"
printf '%s\n' 'c.fonts.default_size = "30pt"' > "$QUTE_CONFIG/config.py"
printf '%s\n' '# my own bindings, nothing to do with the plugin' > "$QUTE_CONFIG/bindings-personal.py"
printf '[Default Applications]\napplication/pdf=org.pwmt.zathura.desktop\ntext/html=firefox.desktop\n' \
  > "$XDG_CONFIG_HOME/mimeapps.list"
printf '%s\n' 'firefox.desktop' > "$XDG_SANDBOX_STATE/web-browser"
user_config_sha="$(sha256sum "$QUTE_CONFIG/config.py" | cut -d' ' -f1)"

# ── install ───────────────────────────────────────────────────────────────────
install_out="$(bash "$ROOT/install.sh" 2>&1)"
is "install exits 0 in the sandbox" "$?" "0"

is "config.py is a symlink into the checkout" \
   "$(readlink -f "$QUTE_CONFIG/config.py")" "$(readlink -f "$ROOT/config/config.py")"
for name in "${CONFIG_MODULES[@]}"; do
  is "config module $name is linked" \
     "$(readlink -f "$QUTE_CONFIG/$name")" "$(readlink -f "$ROOT/config/$name")"
done
for name in "${GREASEMONKEY_SCRIPTS[@]}"; do
  is "greasemonkey script $name is linked" \
     "$(readlink -f "$GREASEMONKEY/$name")" "$(readlink -f "$ROOT/userscripts/$name")"
done
for name in "${USERSCRIPTS[@]}"; do
  is "userscript $name is linked in the data dir" \
     "$(readlink -f "$DATA_USERSCRIPTS/$name")" "$(readlink -f "$ROOT/userscripts/$name")"
  is "userscript $name is linked in the config dir" \
     "$(readlink -f "$QUTE_CONFIG/userscripts/$name")" "$(readlink -f "$ROOT/userscripts/$name")"
done
is "the theme-set hook is installed" \
   "$(readlink -f "$HOOK_DIR/qutebrowser-theme-set")" \
   "$(readlink -f "$ROOT/hooks/qutebrowser-theme-set")"
is "the browser defaults were recorded before being overwritten" \
   "$(grep -F 'web-browser=' "$STATE/mime-defaults")" "web-browser=firefox.desktop"
is "qutebrowser is the default web browser after install" \
   "$(cat "$XDG_SANDBOX_STATE/web-browser")" "$QUTE_DESKTOP"
is "text/html points at qutebrowser after install" \
   "$(xdg-mime query default text/html)" "$QUTE_DESKTOP"

backup="$(ls "$QUTE_CONFIG"/config.py.bak.* 2>/dev/null | head -1)"
if [[ -n $backup ]]; then
  is "the user's config was backed up byte-identically" \
     "$(sha256sum "$backup" | cut -d' ' -f1)" "$user_config_sha"
else
  bad "the user's config was backed up byte-identically (no backup file)"
fi

# A user who edited one of our files in place: same name, different content. The
# uninstall must treat it as theirs.
rm -f "$QUTE_CONFIG/themes.py"
printf '%s\n' 'c.colors.webpage.darkmode.enabled = true' > "$QUTE_CONFIG/themes.py"

# Scripts this plugin GENERATES rather than copies: the compiled cosmetic filter set and
# one per-domain fix script. They have no source to compare against, so the header stamp is
# what has to make them ours — and a foreign file that merely shares the name stays.
gen_cosmetic="$GREASEMONKEY/cosmetic-filters.js"
gen_sitefix="$GREASEMONKEY/omarchy-sitefix-example.org.js"
foreign_sitefix="$GREASEMONKEY/omarchy-sitefix-foreign.example.js"
printf '%s\n' '// ==UserScript==' \
  '// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser' > "$gen_cosmetic"
printf '%s\n' '// ==UserScript==' \
  '// @namespace    https://github.com/Maximilian-Maag/omarchy-qutebrowser' > "$gen_sitefix"
printf '%s\n' '// ==UserScript==' \
  '// @namespace    https://someone-else.example/' > "$foreign_sitefix"

# ── uninstall ─────────────────────────────────────────────────────────────────
find "$TMP" -mindepth 1 | sort > "$SNAP/before"
uninstall_out="$(bash "$ROOT/install.sh" --uninstall 2>&1)"
is "uninstall exits 0" "$?" "0"
find "$TMP" -mindepth 1 | sort > "$SNAP/after"

# Everything the docs say install adds, and nothing besides. themes.py is left out on
# purpose: the user replaced it, so it must survive.
{
  for name in "${CONFIG_MODULES[@]}"; do
    [[ $name == themes.py ]] && continue
    printf '%s\n' "$QUTE_CONFIG/$name"
  done
  for name in "${USERSCRIPTS[@]}"; do
    printf '%s\n' "$QUTE_CONFIG/userscripts/$name" "$DATA_USERSCRIPTS/$name"
  done
  for name in "${GREASEMONKEY_SCRIPTS[@]}"; do
    printf '%s\n' "$GREASEMONKEY/$name"
  done
  printf '%s\n' "$gen_cosmetic" "$gen_sitefix"
  printf '%s\n' "$HOOK_DIR/qutebrowser-theme-set" \
                "$STATE/active-theme" "$STATE/mime-defaults" "$STATE"
} | sort > "$SNAP/expected"

comm -23 "$SNAP/before" "$SNAP/after" > "$SNAP/removed"   # present before, gone after
if cmp -s "$SNAP/removed" "$SNAP/expected"; then
  ok "the uninstall removed exactly the documented artifacts"
else
  bad "the uninstall removed exactly the documented artifacts"
  printf '  not removed, but should have been:\n'
  comm -23 "$SNAP/expected" "$SNAP/removed" | sed 's/^/    /'
  printf '  removed, but not ours to remove:\n'
  comm -13 "$SNAP/expected" "$SNAP/removed" | sed 's/^/    /'
fi

is "a user's own themes.py survives, untouched" \
   "$(cat "$QUTE_CONFIG/themes.py")" "c.colors.webpage.darkmode.enabled = true"
is "a user's unrelated file in the config dir survives" \
   "$(cat "$QUTE_CONFIG/bindings-personal.py")" "# my own bindings, nothing to do with the plugin"
is "the config.py backup is left in place and untouched" \
   "$(sha256sum "$backup" | cut -d' ' -f1)" "$user_config_sha"

case "$uninstall_out" in
  *"config.py.bak."*) ok "the uninstall names the config.py backup it keeps";;
  *) bad "the uninstall names the config.py backup it keeps";;
esac

is "a foreign script that shares our prefix is kept" \
   "$([[ -e $foreign_sitefix ]] && echo kept || echo gone)" "kept"

# Browser defaults: what was there before install comes back.
is "the default web browser is restored" \
   "$(cat "$XDG_SANDBOX_STATE/web-browser")" "firefox.desktop"
is "text/html is handed back to firefox" "$(xdg-mime query default text/html)" "firefox.desktop"
if grep -qF "=$QUTE_DESKTOP" "$XDG_CONFIG_HOME/mimeapps.list"; then
  bad "no qutebrowser assignment may survive in mimeapps.list"
else
  ok "no qutebrowser assignment survives in mimeapps.list"
fi
if grep -qF "application/pdf=org.pwmt.zathura.desktop" "$XDG_CONFIG_HOME/mimeapps.list"; then
  ok "an unrelated handler in mimeapps.list survives"
else
  bad "an unrelated handler in mimeapps.list survives"
fi

# ── a second run is a no-op ───────────────────────────────────────────────────
find "$TMP" -mindepth 1 | sort > "$SNAP/before2"
second_out="$(bash "$ROOT/install.sh" --uninstall 2>&1)"
is "a second uninstall exits 0" "$?" "0"
find "$TMP" -mindepth 1 | sort > "$SNAP/after2"
is "a second uninstall removes nothing and writes nothing" \
   "$(comm -3 "$SNAP/before2" "$SNAP/after2")" ""
case "$second_out" in
  *"Removed "*|*"Dropped "*|*"restored"*)
    bad "a second uninstall must not report any action (got: $second_out)";;
  *) ok "a second uninstall reports no action";;
esac

echo
if (( fails == 0 )); then echo "install.sh --uninstall: all shell assertions passed"; exit 0; fi
echo "install.sh --uninstall: $fails assertion(s) failed"; exit 1

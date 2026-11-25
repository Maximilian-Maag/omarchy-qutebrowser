#!/bin/bash
# omarchy-qutebrowser install script
#
#   ./install.sh             install / update everything
#   ./install.sh --uninstall remove exactly what an install added, and only that
#
# Run once after cloning the plugin, or re-run to update symlinks.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
QUTE_CONFIG_DIR="$CONFIG_HOME/qutebrowser"
QUTE_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qutebrowser"
GREASEMONKEY_DIR="$QUTE_DATA_DIR/greasemonkey"
USERSCRIPTS_DIR="$QUTE_DATA_DIR/userscripts"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-qutebrowser"
HOOK_DIR="$CONFIG_HOME/omarchy/hooks/theme-set.d"
HOOK_NAME="qutebrowser-theme-set"
MIME_STATE="$STATE_DIR/mime-defaults"

# The exact artifacts install adds. --uninstall reverses these lists and nothing
# else. It is one list rather than two so a script added to the install loop can
# never be forgotten by the uninstall loop.
#
# config.py    — the browser config; it sources the three modules below.
# themes.py    — the Omarchy theme palette map (22 stock themes).
# site-overrides.py — generated per-domain fixes, loaded by config.py.
# omarchy_webauthn.py — the WebAuthn UX handler: qutebrowser never answers Qt's
#                  WebAuthn UX request, so without it passkeys hang.
CONFIG_MODULES=(config.py themes.py site-overrides.py omarchy_webauthn.py)

# Greasemonkey scripts, each scoped to the hosts it is for:
#   youtube-adblock                    — strip the ad payload out of the player response
#   cookie-banner-remover              — click through consent walls
#   omarchy-google-signin-chrome-identity — JavaScript half of the stock-Chrome identity for Google
#   omarchy-ms-signin-chrome-identity  — the same for the Microsoft sign-in hosts
#   omarchy-chrome-identity            — the same for bot-managed sites (LinkedIn, Kleinanzeigen, immowelt)
#   omarchy-linkedin-root-redirect     — leave LinkedIn's path-scoped Cloudflare block page
GREASEMONKEY_SCRIPTS=(
  youtube-adblock.js
  cookie-banner-remover.js
  omarchy-google-signin-chrome-identity.js
  omarchy-ms-signin-chrome-identity.js
  omarchy-chrome-identity.js
  omarchy-linkedin-root-redirect.js
)

# The userscripts, linked into BOTH the data dir (where qutebrowser looks up
# :spawn --userscript) and the config dir (where a fresh profile finds them).
USERSCRIPTS=(qute-yt-dl qute-keepassxc-setup qute-keepassxc-fill qute-zoom qute-ai-fix qute-reader)

QUTE_DESKTOP="org.qutebrowser.qutebrowser.desktop"
BROWSER_MIMES=(
  x-scheme-handler/http
  x-scheme-handler/https
  x-scheme-handler/qute
  text/html
  text/xml
  application/xhtml+xml
  application/xml
)


# ── Generated scripts ────────────────────────────────────────────────────────
# Two greasemonkey scripts are written at install/run time instead of being copied, so
# there is no source file to compare them against: cosmetic-filters.js (compiled by
# tools/build_cosmetic.py) and omarchy-sitefix-<domain>.js (written by site-overrides.py
# from the per-domain fix files). Both stamp this project's @namespace in their header,
# and that stamp — not the file name — is what has to be there before anything is deleted.
remove_generated() {
  local dest="$1"
  [[ -f $dest ]] || return 0
  if head -n 12 "$dest" 2>/dev/null | grep -q "Maximilian-Maag/omarchy-qutebrowser"; then
    rm -f "$dest"; echo "  Removed $dest"
  else
    echo "  WARNING: $dest is not ours — left alone."
  fi
}

# ── Uninstall ────────────────────────────────────────────────────────────────
# remove_installed <installed-path> <source-path>
# Deletes a path ONLY when it is a symlink to our source or a byte-identical copy of
# it. Anything else at that path is the user's — a config they wrote by hand, a theme
# they copied in and edited — and is reported, never removed.
remove_installed() {
  local dest="$1" src="$2"
  if [[ -L $dest ]] && [[ $(readlink -f "$dest") == "$(readlink -f "$src")" ]]; then
    rm -f "$dest"; echo "  Removed $dest"
  elif [[ -f $dest ]] && cmp -s "$src" "$dest"; then
    rm -f "$dest"; echo "  Removed $dest"
  elif [[ -e $dest ]]; then
    echo "  WARNING: $dest is not ours — left alone."
  fi
}

# drop_our_assignment <mime> — take the exact "<mime>=<QUTE_DESKTOP>" line out of the
# user's mimeapps.list. Used where install recorded NO previous handler: the type must
# fall back to the system default rather than stay pointed at a browser that is going
# away. Only that one whole line is removed; the file is otherwise left as it was.
drop_our_assignment() {
  local key="$1" list="$CONFIG_HOME/mimeapps.list" kept
  [[ -f $list ]] || return 0
  grep -qxF -- "$key=$QUTE_DESKTOP" "$list" || return 0
  kept="$(mktemp)"
  grep -vxF -- "$key=$QUTE_DESKTOP" "$list" > "$kept" || true
  mv "$kept" "$list"
  echo "  Dropped $key from $list (it had no handler before install)"
}

# revert_web_defaults — hand the MIME types back to the handlers install recorded
# before it overwrote them, but only while the current handler is still ours: if the
# user has picked another browser since, their choice wins and nothing is touched.
# xdg-settings and xdg-mime can only overwrite, never un-set, which is why install
# writes the old values down at all.
revert_web_defaults() {
  local key prev current
  while IFS='=' read -r key prev; do
    [[ -n $key ]] || continue
    if [[ $key == web-browser ]]; then
      current="$(xdg-settings get default-web-browser 2>/dev/null || true)"
      [[ $current == "$QUTE_DESKTOP" ]] || continue
      if [[ -n $prev ]]; then
        xdg-settings set default-web-browser "$prev" 2>/dev/null \
          && echo "  Default web browser restored to $prev" \
          || echo "  WARNING: could not restore the default web browser to $prev."
      else
        drop_our_assignment x-scheme-handler/http
        drop_our_assignment x-scheme-handler/https
        echo "  WARNING: no previous default web browser was recorded; pick one with:"
        echo "    xdg-settings set default-web-browser <name>.desktop"
      fi
    else
      current="$(xdg-mime query default "$key" 2>/dev/null || true)"
      [[ $current == "$QUTE_DESKTOP" ]] || continue
      if [[ -n $prev ]]; then
        xdg-mime default "$prev" "$key" 2>/dev/null \
          && echo "  $key handed back to $prev" \
          || echo "  WARNING: could not hand $key back to $prev."
      else
        drop_our_assignment "$key"
      fi
    fi
  done < "$MIME_STATE"
}

# Reverses exactly what an install adds, and nothing else. Idempotent: a second run
# finds nothing left to remove and still exits 0.
uninstall() {
  echo "omarchy-qutebrowser: uninstalling"
  local name file
  local -a left=()

  # 1. The config modules symlinked into the qutebrowser config.
  for name in "${CONFIG_MODULES[@]}"; do
    remove_installed "$QUTE_CONFIG_DIR/$name" "$PLUGIN_DIR/config/$name"
  done

  # 2. The userscripts, from both places install links them into.
  for name in "${USERSCRIPTS[@]}"; do
    remove_installed "$QUTE_CONFIG_DIR/userscripts/$name" "$PLUGIN_DIR/userscripts/$name"
    remove_installed "$USERSCRIPTS_DIR/$name" "$PLUGIN_DIR/userscripts/$name"
  done

  # 3. The Greasemonkey scripts.
  for name in "${GREASEMONKEY_SCRIPTS[@]}"; do
    remove_installed "$GREASEMONKEY_DIR/$name" "$PLUGIN_DIR/userscripts/$name"
  done

  # 3b. The scripts the install and the config generate rather than copy. Leaving them
  # behind means a browser that keeps hiding elements for a plugin that is gone.
  remove_generated "$GREASEMONKEY_DIR/cosmetic-filters.js"
  for file in "$GREASEMONKEY_DIR"/omarchy-sitefix-*.js; do
    [[ -e $file ]] && remove_generated "$file"
  done

  # 4. The theme-set hook (`omarchy hook install` symlinks it into theme-set.d).
  remove_installed "$HOOK_DIR/$HOOK_NAME" "$PLUGIN_DIR/hooks/$HOOK_NAME"

  # 5. The browser defaults install overwrote.
  if [[ -f $MIME_STATE ]]; then
    revert_web_defaults
    rm -f "$MIME_STATE"
    echo "  Removed the recorded browser defaults ($MIME_STATE)"
  fi

  # 6. The state install wrote. Only that file: $STATE_DIR/yt-dl holds download logs
  # and runner scripts, which are the user's history rather than an install artifact,
  # so the directory is only removed when nothing else is left in it.
  if [[ -e $STATE_DIR/active-theme ]]; then
    rm -f "$STATE_DIR/active-theme"; echo "  Removed $STATE_DIR/active-theme"
  fi
  rmdir "$STATE_DIR" 2>/dev/null || true

  # 7. Say what is deliberately kept. The config.py backup is the user's own file —
  # install moved it aside, so it is theirs to take back, not ours to delete.
  for file in "$QUTE_CONFIG_DIR"/config.py.bak.*; do
    [[ -e $file ]] && left+=("$file")
  done
  if (( ${#left[@]} )); then
    echo "  Kept the config.py backup(s) install made — your original config, if you want it back:"
    printf '    %s\n' "${left[@]}"
  fi

  echo ""
  echo "Done. The system-wide default-browser files (/etc/xdg/mimeapps.list,"
  echo "/usr/share/applications/mimeapps.list, /usr/bin/x-www-browser) need root and are"
  echo "left in place; remove them by hand if qutebrowser is going away entirely."
}

if [[ ${1:-} == --uninstall ]]; then
  uninstall
  exit 0
fi

echo "omarchy-qutebrowser: installing from $PLUGIN_DIR"

# ── 1. Dependencies ──────────────────────────────────────────────────────────
echo "Checking dependencies..."
# python-adblock and python-pynacl must come from pacman: qutebrowser runs on
# the system Python (/usr/bin/python3), while pip installs into the mise-managed
# interpreter, so a pip-installed nacl would never be importable by qutebrowser.
omarchy pkg add qutebrowser keepassxc yt-dlp ffmpeg python-adblock python-pynacl
echo "  Dependencies OK."

# The password-fill userscript's shebang is '#!/usr/bin/env python3', so it runs
# under the FIRST python3 on PATH — which is not necessarily the interpreter
# python-pynacl was just installed for (e.g. a mise/pyenv shim). Check the one
# qutebrowser will actually use, so a missing nacl surfaces here and not as a
# silent "pw does nothing".
if python3 -c 'import nacl' 2>/dev/null; then
  echo "  PyNaCl OK for $(command -v python3)"
else
  echo "  WARNING: $(command -v python3) cannot import nacl."
  echo "           'pw' password fill will not work. Fix with:"
  echo "             python3 -m pip install pynacl"
fi

# ── 2. Config ────────────────────────────────────────────────────────────────
mkdir -p "$QUTE_CONFIG_DIR"

if [[ -f "$QUTE_CONFIG_DIR/config.py" && ! -L "$QUTE_CONFIG_DIR/config.py" ]]; then
  ts=$(date +%s)
  mv "$QUTE_CONFIG_DIR/config.py" "$QUTE_CONFIG_DIR/config.py.bak.$ts"
  echo "  Backed up existing config.py to config.py.bak.$ts"
fi

ln -sf "$PLUGIN_DIR/config/config.py" "$QUTE_CONFIG_DIR/config.py"
ln -sf "$PLUGIN_DIR/config/themes.py" "$QUTE_CONFIG_DIR/themes.py"
echo "  Linked config.py and themes.py -> $QUTE_CONFIG_DIR/"

# ── 3. Greasemonkey (YouTube ad-block + cookie banners) ──────────────────────
mkdir -p "$GREASEMONKEY_DIR"
for script in "${GREASEMONKEY_SCRIPTS[@]}"; do
  ln -sf "$PLUGIN_DIR/userscripts/$script" "$GREASEMONKEY_DIR/$script"
done
# Passkey platform-probe: RETIRED. It existed only because QtWebEngine answered
# isUserVerifyingPlatformAuthenticatorAvailable() false; the engine patch (docs/engine-patch/)
# makes the engine answer true, so Microsoft signs in with no page-visible correction (verified
# 2026-10-12). Do NOT install it active: doing so would undo a deliberate disable and re-add a
# page-visible deviation the engine patch removed. It stays in the repo as an opt-in fallback only.
rm -f "$GREASEMONKEY_DIR/omarchy-ms-passkey-platform-probe.js"
# site-fixes.js is gone — per-domain fixes are generated scripts now
# (config/site-overrides.py -> greasemonkey/omarchy-sitefix-<domain>.js).
rm -f "$GREASEMONKEY_DIR/site-fixes.js"
echo "  Linked Greasemonkey scripts -> $GREASEMONKEY_DIR/"

# ── 4. Userscripts ───────────────────────────────────────────────────────────
mkdir -p "$USERSCRIPTS_DIR" "$QUTE_CONFIG_DIR/userscripts"
for script in "${USERSCRIPTS[@]}"; do
  chmod +x "$PLUGIN_DIR/userscripts/$script"
  ln -sf "$PLUGIN_DIR/userscripts/$script" "$USERSCRIPTS_DIR/$script"
  ln -sf "$PLUGIN_DIR/userscripts/$script" "$QUTE_CONFIG_DIR/userscripts/$script"
done
echo "  Linked userscripts (${USERSCRIPTS[*]})"
chmod +x "$PLUGIN_DIR/bin/reader-server"
echo "  Reader server: $PLUGIN_DIR/bin/reader-server (started on demand by ,r)"
chmod +x "$PLUGIN_DIR/bin/ai-fix-overblocking"
echo "  Over-blocking check: $PLUGIN_DIR/bin/ai-fix-overblocking (run by ,af)"

# ── 4b. Config modules ────────────────────────────────────────────────────────
# site-overrides.py (generated per-domain fixes) and omarchy_webauthn.py (the
# WebAuthn UX handler) sit next to config.py, which sources both.
for name in "${CONFIG_MODULES[@]}"; do
  ln -sf "$PLUGIN_DIR/config/$name" "$QUTE_CONFIG_DIR/$name"
done
echo "  Linked ${CONFIG_MODULES[*]} -> $QUTE_CONFIG_DIR/"

# ── 4c. Cosmetic filters ─────────────────────────────────────────────────────
# qutebrowser refuses ad requests but does not hide elements, so a publisher's own ad boxes
# and sponsored teasers stay on the page (golem.de: .go-ad-slot, the "ANZEIGE" link block).
# This compiles the hide rules of the same lists into one Greasemonkey script. The download
# needs the network once; when it fails the previously compiled script is kept, and the
# message says how to retry rather than pretending the step worked.
chmod +x "$PLUGIN_DIR/bin/omarchy-cosmetic-update"
echo "  Cosmetic filters: $PLUGIN_DIR/bin/omarchy-cosmetic-update (rebuild from CLI; no binding)"
if python3 "$PLUGIN_DIR/tools/build_cosmetic.py" \
     --template "$PLUGIN_DIR/userscripts/cosmetic-filters.js" \
     --output "$GREASEMONKEY_DIR/cosmetic-filters.js"; then
  echo "  Compiled cosmetic filters -> $GREASEMONKEY_DIR/cosmetic-filters.js"
else
  echo "  WARNING: cosmetic filters not compiled (offline?); retry with: omarchy-cosmetic-update" >&2
fi

# ── 5. Theme-set hook ────────────────────────────────────────────────────────
omarchy hook install theme-set "$PLUGIN_DIR/hooks/qutebrowser-theme-set"
echo "  Installed theme-set hook -> ~/.config/omarchy/hooks/theme-set.d/qutebrowser-theme-set"

# ── 6. Default browser ───────────────────────────────────────────────────────
# 6a. User-level. What was there before is written down once, because xdg-settings
# and xdg-mime can only overwrite a handler, never un-set it: --uninstall needs the
# old values to hand the types back. Guarded on the file, not on the values, so a
# re-run never records qutebrowser itself as the previous handler. A value that is
# already ours is recorded as empty: upgrading from a version that kept no record
# must not leave qutebrowser as its own fallback.
mkdir -p "$STATE_DIR"
if [[ ! -f $MIME_STATE ]]; then
  prev_browser="$(xdg-settings get default-web-browser 2>/dev/null || true)"
  [[ $prev_browser == "$QUTE_DESKTOP" ]] && prev_browser=""
  {
    printf 'web-browser=%s\n' "$prev_browser"
    for mime in "${BROWSER_MIMES[@]}"; do
      prev_handler="$(xdg-mime query default "$mime" 2>/dev/null || true)"
      [[ $prev_handler == "$QUTE_DESKTOP" ]] && prev_handler=""
      printf '%s=%s\n' "$mime" "$prev_handler"
    done
  } > "$MIME_STATE"
fi
CURRENT=$(xdg-settings get default-web-browser 2>/dev/null || echo "")
if [[ $CURRENT != "$QUTE_DESKTOP" ]]; then
  xdg-settings set default-web-browser "$QUTE_DESKTOP"
  echo "  Set user-level default browser (was: ${CURRENT:-none})"
else
  echo "  User default browser already set."
fi
for mime in "${BROWSER_MIMES[@]}"; do
  xdg-mime default "$QUTE_DESKTOP" "$mime"
done
echo "  Registered MIME types for user."

# 6b. System-wide (requires root). --uninstall does not touch these: they need root
# and the previous values were never recorded, so it names them instead of guessing.
echo "  Setting system-wide default browser (requires sudo)..."
if (( EUID == 0 )); then
  bash "$PLUGIN_DIR/bin/set-system-default"
elif command -v sudo >/dev/null 2>&1; then
  sudo bash "$PLUGIN_DIR/bin/set-system-default"
else
  pkexec bash "$PLUGIN_DIR/bin/set-system-default"
fi

# ── 7. Initial theme state ────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
CURRENT_THEME=$(omarchy theme current 2>/dev/null | tr '[:upper:] ' '[:lower:]-' || echo "catppuccin")
echo "$CURRENT_THEME" > "$STATE_DIR/active-theme"
echo "  Initial theme: $CURRENT_THEME"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "Done! Start qutebrowser with: qutebrowser"
echo ""
echo "Bindings:"
echo "  Alt+Shift+U / pw  — KeePassXC password fill (enable Browser Integration in KeePassXC first)"
echo "  ,dv               — download current page as video (yt-dlp)"
echo "  ,dm               — download current page as MP3  (yt-dlp + ffmpeg)"
echo "  ,y                — open YouTube"
echo "  ,ab               — update ad block lists"
echo ""
echo "Theme switches automatically with: omarchy theme set <name>"

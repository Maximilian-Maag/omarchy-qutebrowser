#!/bin/bash
# omarchy-qutebrowser install script
# Run once after cloning the plugin, or re-run to update symlinks.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUTE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qutebrowser"
QUTE_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qutebrowser"
GREASEMONKEY_DIR="$QUTE_DATA_DIR/greasemonkey"
USERSCRIPTS_DIR="$QUTE_DATA_DIR/userscripts"

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
ln -sf "$PLUGIN_DIR/userscripts/youtube-adblock.js" \
       "$GREASEMONKEY_DIR/youtube-adblock.js"
ln -sf "$PLUGIN_DIR/userscripts/cookie-banner-remover.js" \
       "$GREASEMONKEY_DIR/cookie-banner-remover.js"
# site-fixes.js is gone — per-domain fixes are generated scripts now
# (config/site-overrides.py -> greasemonkey/omarchy-sitefix-<domain>.js).
rm -f "$GREASEMONKEY_DIR/site-fixes.js"
echo "  Linked Greasemonkey scripts -> $GREASEMONKEY_DIR/"

# ── 4. Userscripts ───────────────────────────────────────────────────────────
mkdir -p "$USERSCRIPTS_DIR" "$QUTE_CONFIG_DIR/userscripts"
for script in qute-yt-dl qute-keepassxc-setup qute-keepassxc-fill qute-zoom qute-ai-fix qute-reader; do
  chmod +x "$PLUGIN_DIR/userscripts/$script"
  ln -sf "$PLUGIN_DIR/userscripts/$script" "$USERSCRIPTS_DIR/$script"
  ln -sf "$PLUGIN_DIR/userscripts/$script" "$QUTE_CONFIG_DIR/userscripts/$script"
done
echo "  Linked userscripts (qute-yt-dl, qute-keepassxc-setup, qute-keepassxc-fill, qute-zoom, qute-ai-fix, qute-reader)"
chmod +x "$PLUGIN_DIR/bin/reader-server"
echo "  Reader server: $PLUGIN_DIR/bin/reader-server (started on demand by ,r)"

# ── 4b. Config modules ────────────────────────────────────────────────────────
ln -sf "$PLUGIN_DIR/config/site-overrides.py" "$QUTE_CONFIG_DIR/site-overrides.py"
echo "  Linked site-overrides.py -> $QUTE_CONFIG_DIR/"

# ── 5. Theme-set hook ────────────────────────────────────────────────────────
omarchy hook install theme-set "$PLUGIN_DIR/hooks/theme-set"
echo "  Installed theme-set hook -> ~/.config/omarchy/hooks/theme-set.d/theme-set"

# ── 6. Default browser ───────────────────────────────────────────────────────
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

# 6a. User-level
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

# 6b. System-wide (requires root)
echo "  Setting system-wide default browser (requires sudo)..."
if [[ $EUID -eq 0 ]]; then
  bash "$PLUGIN_DIR/bin/set-system-default"
elif command -v sudo >/dev/null 2>&1; then
  sudo bash "$PLUGIN_DIR/bin/set-system-default"
else
  pkexec bash "$PLUGIN_DIR/bin/set-system-default"
fi

# ── 7. Initial theme state ────────────────────────────────────────────────────
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-qutebrowser"
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

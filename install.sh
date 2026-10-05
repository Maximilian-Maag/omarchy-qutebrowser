#!/bin/bash
# omarchy-qutebrowser install script
# Run once after cloning the plugin, or re-run to update symlinks.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

QUTE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qutebrowser"
QUTE_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qutebrowser"
GREASEMONKEY_DIR="$QUTE_DATA_DIR/greasemonkey"

echo "omarchy-qutebrowser: installing from $PLUGIN_DIR"

# ── 1. Config ────────────────────────────────────────────────────────────────
mkdir -p "$QUTE_CONFIG_DIR"

# Back up any existing config
if [[ -f "$QUTE_CONFIG_DIR/config.py" && ! -L "$QUTE_CONFIG_DIR/config.py" ]]; then
  ts=$(date +%s)
  mv "$QUTE_CONFIG_DIR/config.py" "$QUTE_CONFIG_DIR/config.py.bak.$ts"
  echo "  Backed up existing config.py to config.py.bak.$ts"
fi

# Symlink config.py and themes.py
ln -sf "$PLUGIN_DIR/config/config.py" "$QUTE_CONFIG_DIR/config.py"
ln -sf "$PLUGIN_DIR/config/themes.py" "$QUTE_CONFIG_DIR/themes.py"
echo "  Linked config.py and themes.py -> $QUTE_CONFIG_DIR/"

# ── 2. Greasemonkey userscript ───────────────────────────────────────────────
mkdir -p "$GREASEMONKEY_DIR"
ln -sf "$PLUGIN_DIR/userscripts/youtube-adblock.js" \
       "$GREASEMONKEY_DIR/youtube-adblock.js"
echo "  Linked youtube-adblock.js -> $GREASEMONKEY_DIR/"

# ── 3. KeePassXC userscript ──────────────────────────────────────────────────
# qute-keepassxc ships with qutebrowser and is already on the userscript PATH.
# Check pynacl is available.
if ! python3 -c "import nacl" 2>/dev/null; then
  echo "  WARNING: pynacl not found. Installing..."
  pip install --quiet pynacl
  echo "  Installed pynacl."
fi
echo "  KeePassXC userscript: qute-keepassxc (ships with qutebrowser) — OK"

# ── 4. Theme-set hook ────────────────────────────────────────────────────────
omarchy hook install theme-set "$PLUGIN_DIR/hooks/theme-set"
echo "  Installed theme-set hook -> ~/.config/omarchy/hooks/theme-set.d/theme-set"

# ── 5. Set qutebrowser as the default browser ────────────────────────────────
CURRENT=$(xdg-settings get default-web-browser 2>/dev/null || echo "")
if [[ $CURRENT != "org.qutebrowser.qutebrowser.desktop" ]]; then
  xdg-settings set default-web-browser org.qutebrowser.qutebrowser.desktop
  xdg-mime default org.qutebrowser.qutebrowser.desktop x-scheme-handler/http
  xdg-mime default org.qutebrowser.qutebrowser.desktop x-scheme-handler/https
  echo "  Set qutebrowser as default browser (was: ${CURRENT:-none})"
else
  echo "  qutebrowser is already the default browser."
fi

# ── 6. Write initial theme state ─────────────────────────────────────────────
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-qutebrowser"
mkdir -p "$STATE_DIR"
CURRENT_THEME=$(omarchy theme current 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "catppuccin")
echo "$CURRENT_THEME" > "$STATE_DIR/active-theme"
echo "  Initial theme: $CURRENT_THEME"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "Done! Start qutebrowser with:"
echo "  qutebrowser"
echo ""
echo "KeePassXC bindings:"
echo "  Alt+Shift+U  (insert mode) — fill password from KeePassXC"
echo "  pw           (normal mode) — fill password from KeePassXC"
echo ""
echo "The theme will switch automatically when you run: omarchy theme set <name>"

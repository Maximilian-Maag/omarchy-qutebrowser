"""
omarchy-qutebrowser: main configuration
- Omarchy theme integration (all 22 stock themes + user themes)
- KeePassXC password fill (Alt+Shift+u in insert mode, pw in normal mode)
- Built-in ad blocker (hosts + Brave lists)
- YouTube ad-free via userscript injection
"""

import sys
import os

# ---------------------------------------------------------------------------
# Path: make the config dir importable so we can import themes.py
# ---------------------------------------------------------------------------
config_dir = os.path.dirname(os.path.abspath(__file__))
if config_dir not in sys.path:
    sys.path.insert(0, config_dir)

from themes import apply_theme

# ---------------------------------------------------------------------------
# Theme
# ---------------------------------------------------------------------------
apply_theme(c)  # noqa: F821  (c is injected by qutebrowser)

# ---------------------------------------------------------------------------
# Fonts — pick up the system monospace font; falls back to a sane default
# ---------------------------------------------------------------------------
import subprocess

def _system_monofont(fallback: str = "monospace") -> str:
    try:
        out = subprocess.check_output(
            ["gsettings", "get", "org.gnome.desktop.interface", "monospace-font-name"],
            stderr=subprocess.DEVNULL, text=True,
        ).strip().strip("'\"")
        return out if out else fallback
    except Exception:
        return fallback

mono = _system_monofont()

c.fonts.default_family = mono           # noqa
c.fonts.completion.entry = f"12pt {mono}"
c.fonts.completion.category = f"bold 12pt {mono}"
c.fonts.statusbar = f"12pt {mono}"
c.fonts.hints = f"bold 12pt {mono}"
c.fonts.keyhint = f"12pt {mono}"
c.fonts.messages.error = f"12pt {mono}"
c.fonts.messages.warning = f"12pt {mono}"
c.fonts.messages.info = f"12pt {mono}"
c.fonts.prompts = f"12pt {mono}"
c.fonts.tabs.selected = f"12pt {mono}"
c.fonts.tabs.unselected = f"12pt {mono}"

# ---------------------------------------------------------------------------
# General behaviour
# ---------------------------------------------------------------------------
c.auto_save.session = True
c.session.lazy_restore = True
c.content.autoplay = False
c.content.notifications.enabled = False   # sites must ask
c.downloads.location.ask = True
c.downloads.location.prompt = True
c.scrolling.smooth = True
c.tabs.show = "multiple"
c.tabs.last_close = "close"
c.input.insert_mode.auto_enter = True
c.input.insert_mode.auto_leave = True

# ---------------------------------------------------------------------------
# Privacy
# ---------------------------------------------------------------------------
c.content.cookies.accept = "no-3rdparty"
c.content.geolocation = False
c.content.webrtc_ip_handling_policy = "default-public-interface-only"
c.content.canvas_reading = False
c.content.headers.do_not_track = True
c.content.headers.referer = "same-domain"

# ---------------------------------------------------------------------------
# Ad blocking — built-in host blocker + Brave filter lists
# ---------------------------------------------------------------------------
c.content.blocking.enabled = True
c.content.blocking.method = "both"      # hosts + adblock filter lists
c.content.blocking.hosts.block_subdomains = True
c.content.blocking.adblock.lists = [
    # Brave's curated lists (same ones uBlock Origin uses by default)
    "https://raw.githubusercontent.com/nicehash/ublock-filters/master/filters.txt",
    "https://easylist.to/easylist/easylist.txt",
    "https://easylist.to/easylist/easyprivacy.txt",
    "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
    "https://raw.githubusercontent.com/nicehash/ublock-filters/master/annoyances.txt",
]
c.content.blocking.hosts.lists = [
    "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    "https://raw.githubusercontent.com/nicehash/ublock-filters/master/filters.txt",
]

# ---------------------------------------------------------------------------
# KeePassXC password fill
# Requires qute-keepassxc userscript (ships with qutebrowser) and pynacl.
#   pip install pynacl
# On first use KeePassXC will ask you to allow this client.
# ---------------------------------------------------------------------------
config.bind("<Alt-Shift-u>", "spawn --userscript qute-keepassxc", mode="insert")  # noqa
config.bind("pw", "spawn --userscript qute-keepassxc", mode="normal")             # noqa

# ---------------------------------------------------------------------------
# Keybindings
# ---------------------------------------------------------------------------
# Open new tab / close tab
config.bind("t", "open -t", mode="normal")            # noqa
config.bind("X", "tab-close", mode="normal")          # noqa

# Reload filter lists
config.bind(",ab", "adblock-update", mode="normal")   # noqa

# Toggle dark mode on current page
config.bind(",d", "config-cycle colors.webpage.darkmode.enabled true false", mode="normal")  # noqa

# Hint mode: open in new tab
config.bind("F", "hint all tab", mode="normal")       # noqa

# Quick YouTube shortcut
config.bind(",y", "open https://youtube.com", mode="normal")  # noqa

# ---------------------------------------------------------------------------
# YouTube userscript injection
# Injects a content script on YouTube that prevents the page from showing
# ads. This uses qutebrowser's greasemonkey support; the actual script is
# in userscripts/youtube-adblock.js and is auto-loaded from
# ~/.local/share/qutebrowser/greasemonkey/ (symlinked by install.sh).
# ---------------------------------------------------------------------------
# No Python config needed — Greasemonkey scripts are discovered automatically.
# The script declares @match *://*.youtube.com/* so it runs only there.

# ---------------------------------------------------------------------------
# Per-domain tweaks
# ---------------------------------------------------------------------------
# Allow autoplay on media sites where it makes sense
config.set("content.autoplay", True, "*.youtube.com")          # noqa
config.set("content.autoplay", True, "*.twitch.tv")            # noqa
config.set("content.notifications.enabled", True, "*.github.com")  # noqa

# ---------------------------------------------------------------------------
# Search engines
# ---------------------------------------------------------------------------
c.url.searchengines = {                                         # noqa
    "DEFAULT": "https://search.brave.com/search?q={}",
    "g":       "https://google.com/search?q={}",
    "yt":      "https://youtube.com/search?q={}",
    "gh":      "https://github.com/search?q={}",
    "arch":    "https://archlinux.org/packages/?q={}",
    "aur":     "https://aur.archlinux.org/packages/?K={}",
    "mdn":     "https://developer.mozilla.org/en-US/search?q={}",
    "wp":      "https://en.wikipedia.org/w/index.php?search={}",
}

c.url.start_pages = ["https://search.brave.com"]               # noqa
c.url.default_page = "https://search.brave.com"                # noqa

"""
omarchy-qutebrowser: main configuration
- Omarchy theme integration (all 22 stock themes + user themes)
- KeePassXC password fill (Alt+Shift+u in insert mode, pw in normal mode)
- Built-in ad blocker (hosts + Brave/uBlock lists)
- YouTube ad-free via Greasemonkey script
- yt-dlp video/MP3 download with live progress terminal
- Per-domain zoom persistence
"""

import sys
import os

# ---------------------------------------------------------------------------
# Path: make the config dir importable so we can import themes.py
# ---------------------------------------------------------------------------
# qutebrowser execs config.py without __file__; use config.configdir instead.
try:
    config_dir = str(config.configdir)  # noqa: F821
except Exception:
    import pathlib
    config_dir = str(pathlib.Path.home() / ".config" / "qutebrowser")
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

config.load_autoconfig(False)  # noqa

# Per-site AI fixes — populated by :spawn --userscript qute-ai-fix
# Reads ~/.local/state/omarchy-qutebrowser/site-fixes/<domain>.json
try:
    config.source("site-overrides.py")  # noqa
except Exception:
    pass

# ---------------------------------------------------------------------------
# General behaviour
# ---------------------------------------------------------------------------
c.auto_save.session = True
c.session.lazy_restore = True
c.content.autoplay = False
c.content.notifications.enabled = False   # sites must ask
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
# Ad blocking — built-in host blocker + Brave/uBlock filter lists
# ---------------------------------------------------------------------------
c.content.blocking.enabled = True
c.content.blocking.method = "both"      # hosts + adblock filter lists
c.content.blocking.hosts.block_subdomains = True
c.content.blocking.adblock.lists = [
    "https://easylist.to/easylist/easylist.txt",
    "https://easylist.to/easylist/easyprivacy.txt",
    "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
    # Cookie consent banners
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt",
    "https://www.fanboy.co.nz/fanboy-cookiemonster.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt",
]
c.content.blocking.hosts.lists = [
    "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
]

# ---------------------------------------------------------------------------
# Search engines
# Override DEFAULT to change the search engine used when typing in the bar.
# ---------------------------------------------------------------------------
_default_search = os.environ.get(
    "QUTE_DEFAULT_SEARCH",
    "https://search.brave.com/search?q={}"
)

c.url.searchengines = {                                         # noqa
    "DEFAULT": _default_search,
    "g":       "https://google.com/search?q={}",
    "dd":      "https://duckduckgo.com/?q={}",
    "yt":      "https://youtube.com/search?q={}",
    "gh":      "https://github.com/search?q={}",
    "arch":    "https://archlinux.org/packages/?q={}",
    "aur":     "https://aur.archlinux.org/packages/?K={}",
    "mdn":     "https://developer.mozilla.org/en-US/search?q={}",
    "wp":      "https://en.wikipedia.org/w/index.php?search={}",
}

_start_page = os.environ.get("QUTE_START_PAGE", "https://search.brave.com")
c.url.start_pages = [_start_page]                               # noqa
c.url.default_page = _start_page                                # noqa

# ---------------------------------------------------------------------------
# KeePassXC password fill
# Uses --insecure (no GPG required — association key stored in plaintext).
# First-time setup: run  :spawn --userscript qute-keepassxc-setup
# Enable Browser Integration in KeePassXC: Tools > Settings > Browser Integration
# ---------------------------------------------------------------------------
config.bind("<Alt-Shift-u>", "spawn --userscript qute-keepassxc --insecure", mode="insert")  # noqa
config.bind("pw",            "spawn --userscript qute-keepassxc --insecure", mode="normal")  # noqa
config.bind(",kp",           "spawn --userscript qute-keepassxc-setup",      mode="normal")  # noqa  check setup

# ---------------------------------------------------------------------------
# Keybindings
# ---------------------------------------------------------------------------
# Tabs
config.bind("t", "open -t",   mode="normal")  # noqa
config.bind("X", "tab-close", mode="normal")  # noqa

# Private window (opens current URL in a temp profile)
config.bind(",p", "open -p {url}", mode="normal")  # noqa

# Reload filter lists
config.bind(",ab", "adblock-update", mode="normal")  # noqa

# Toggle dark mode on current page
config.bind(",d", "config-cycle colors.webpage.darkmode.enabled true false", mode="normal")  # noqa

# Hint mode: open in new tab
config.bind("F", "hint all tab", mode="normal")  # noqa

# Quick YouTube shortcut
config.bind(",y", "open https://youtube.com", mode="normal")  # noqa

# yt-dlp download (floating terminal with live progress)
config.bind(",dv", "spawn --userscript qute-yt-dl video", mode="normal")  # noqa  download video
config.bind(",dm", "spawn --userscript qute-yt-dl mp3",   mode="normal")  # noqa  download mp3

# AI site fix — analyze current page and save per-domain CSS/JS/adblock fixes
config.bind(",af", "spawn --userscript qute-ai-fix", mode="normal")  # noqa

# Per-domain zoom persistence
# ,z  = save current zoom for this domain
# ,zl = restore saved zoom for this domain
# ,zr = reset zoom to 1.0 for this domain
config.bind(",z",  "spawn --userscript qute-zoom",       mode="normal")  # noqa
config.bind(",zl", "spawn --userscript qute-zoom load",  mode="normal")  # noqa
config.bind(",zr", "spawn --userscript qute-zoom reset", mode="normal")  # noqa

# Auto-restore zoom on every page load via Greasemonkey (see userscripts/qute-zoom)
# qutebrowser also calls zoom load via this hook:
config.bind("gd", "spawn --userscript qute-zoom load", mode="normal")   # noqa

# ---------------------------------------------------------------------------
# Per-domain tweaks
# ---------------------------------------------------------------------------
config.set("content.autoplay", True, "*.youtube.com")                    # noqa
config.set("content.autoplay", True, "*.twitch.tv")                       # noqa
config.set("content.notifications.enabled", True, "*.github.com")         # noqa

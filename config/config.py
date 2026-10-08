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
import re
import subprocess

def _system_monofont(fallback: str = "monospace") -> str:
    try:
        out = subprocess.check_output(
            ["gsettings", "get", "org.gnome.desktop.interface", "monospace-font-name"],
            stderr=subprocess.DEVNULL, text=True,
        ).strip().strip("'\"")
    except Exception:
        return fallback
    if not out:
        return fallback
    # gsettings returns e.g. "Adwaita Mono 11" — the trailing point size is not
    # part of the family name, and Qt would treat the whole string as the family
    # (falling back to a default font), so strip it.
    out = re.sub(r"\s+\d+(?:\.\d+)?$", "", out).strip()
    return out or fallback

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
# Reads ~/.local/state/omarchy-qutebrowser/site-fixes/<domain>.json and emits
# per-domain Greasemonkey scripts (see config/site-overrides.py).
try:
    config.source("site-overrides.py")  # noqa
except Exception as _exc:
    print(f"omarchy-qutebrowser: could not source site-overrides.py: {_exc}", file=sys.stderr)

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
# content.headers.referer is left at qutebrowser's default ("same-domain"):
# it is a global-only setting and does not accept URL patterns.

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
# Uses our own qute-keepassxc-fill userscript (MIT): it speaks the same
# KeePassXC-Browser socket protocol and reuses the existing association, but
# fills forms robustly — visible-field-only (never a hidden decoy password
# field), works on multi-step username/password pages (Google, Microsoft,
# Apple), and sets values so React/Vue/Angular frameworks register them.
# First-time setup: run  :spawn --userscript qute-keepassxc-setup
# Enable Browser Integration in KeePassXC: Tools > Settings > Browser Integration
# ---------------------------------------------------------------------------
config.bind("<Alt-Shift-u>", "spawn --userscript qute-keepassxc-fill",        mode="insert")  # noqa
config.bind("pw",            "spawn --userscript qute-keepassxc-fill",        mode="normal")  # noqa
config.bind("pt",            "spawn --userscript qute-keepassxc-fill --totp", mode="normal")  # noqa  TOTP into focused field
config.bind(",kp",           "spawn --userscript qute-keepassxc-setup",       mode="normal")  # noqa  check setup

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

# Toggle dark mode on current page.
# NB: this must NOT be bound to ",d" — qutebrowser's keybinding trie fires a
# binding the moment it has a command, even when longer bindings (",dm", ",dv")
# share the prefix, so ",d" would shadow the yt-dlp downloads. ",dt" avoids it.
config.bind(",dt", "config-cycle colors.webpage.darkmode.enabled true false", mode="normal")  # noqa

# Hint mode: open in new tab
config.bind("F", "hint all tab", mode="normal")  # noqa

# Quick YouTube shortcut
config.bind(",y", "open https://youtube.com", mode="normal")  # noqa

# yt-dlp download (floating terminal with live progress)
config.bind(",dv", "spawn --userscript qute-yt-dl video", mode="normal")  # noqa  download video
config.bind(",dm", "spawn --userscript qute-yt-dl mp3",   mode="normal")  # noqa  download mp3

# Video picker: on a page that is NOT itself a video (search results, a channel,
# any list) ,dv/,dm ask qute-yt-dl to show qutebrowser hints on this `ytdl` link
# group, so you choose which video to download; on a video page the current video
# is used directly. NOTE: config.set('hints.selectors.ytdl', ...) is rejected
# ("No option 'hints.selectors.ytdl'") — the option dict must be mutated.
try:
    c.hints.selectors['ytdl'] = [  # type: ignore[index]
        'a[href*="watch?v="]',
        'a[href*="youtu.be/"]',
        'a[href*="/shorts/"]',
        'a[href*="youtube.com/live/"]',
        'a[href*="vimeo.com/"]',
        'a[href*="twitch.tv/videos"]',
        'a[href*="dailymotion.com/video"]',
    ]
except Exception:  # pragma: no cover - option shape differs between versions
    pass

# AI site fix — analyze current page and save per-domain CSS/JS/adblock fixes
config.bind(",af", "spawn --userscript qute-ai-fix", mode="normal")  # noqa

# Reader mode — distraction-free article view (Readability) with local-AI
# per-paragraph / whole-article "possibly AI-written" marking and a summary.
config.bind(",r", "spawn --userscript qute-reader", mode="normal")  # noqa

# Reader page actions (guarded: they no-op unless the current page is the reader).
# qutebrowser swallows page key events in normal mode, so the reader's own
# keyboard shortcuts only work in insert mode — these drive them from a keybinding.
_reader_js = "(function(){var r=window.omarchyReader;if(r){%s}})()"  # noqa
config.bind(",n", "jseval -q " + _reader_js % "r.next();",      mode="normal")  # noqa
config.bind(",N", "jseval -q " + _reader_js % "r.prev();",      mode="normal")  # noqa
config.bind(",f", "jseval -q " + _reader_js % "r.focus();",     mode="normal")  # noqa
config.bind(",m", "jseval -q " + _reader_js % "r.mark();",      mode="normal")  # noqa
config.bind(",M", "jseval -q " + _reader_js % "r.markAll();",   mode="normal")  # noqa
config.bind(",s", "jseval -q " + _reader_js % "r.summarize();", mode="normal")  # noqa
config.bind(",e", "jseval -q " + _reader_js % "r.score();",     mode="normal")  # noqa  AI score (also ◀ / ←)
config.bind(",c", "jseval -q " + _reader_js % "r.factcheck();", mode="normal")  # noqa  fact-check (also ▶ / →)
config.bind(",o", "jseval -q " + _reader_js % "r.wheelopen();", mode="normal")  # noqa  open the focused wheel article
config.bind(",O", "jseval -q " + _reader_js % "r.factcheckall();", mode="normal")  # noqa  fact-check whole article
# Enter opens the focused supporting-article preview (no-op off the reader).
config.bind("<Enter>", "jseval -q " + _reader_js % "r.wheelopen();", mode="normal")  # noqa

# Per-domain zoom persistence
# qutebrowser does not expose the current zoom to userscripts, so zoom is
# remembered by stepping with ,z+ / ,z- (which apply AND save the new level).
# ,z+ = zoom in one step (remembered)   ,z- = zoom out one step (remembered)
# ,zl = apply the saved level           ,zr = forget domain, back to 100%
# gd  = convenience alias for ,zl
config.bind(",z+",  "spawn --userscript qute-zoom in",    mode="normal")  # noqa
config.bind(",z-",  "spawn --userscript qute-zoom out",   mode="normal")  # noqa
config.bind(",zl",  "spawn --userscript qute-zoom load",  mode="normal")  # noqa
config.bind(",zr",  "spawn --userscript qute-zoom reset", mode="normal")  # noqa
config.bind("gd",   "spawn --userscript qute-zoom load",  mode="normal")  # noqa

# ---------------------------------------------------------------------------
# Per-domain tweaks
# ---------------------------------------------------------------------------
config.set("content.autoplay", True, "*.youtube.com")                    # noqa
config.set("content.autoplay", True, "*.twitch.tv")                       # noqa
config.set("content.notifications.enabled", True, "*.github.com")         # noqa

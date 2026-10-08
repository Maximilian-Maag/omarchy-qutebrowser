"""
omarchy-qutebrowser: main configuration
- Omarchy theme integration (all 22 stock themes + user themes)
- KeePassXC password fill (Alt+Shift+u in insert mode, pw in normal mode)
- Built-in ad blocker (hosts + Brave/uBlock lists + our YouTube video-ad list)
- YouTube ad-free via Greasemonkey script (blocks ad requests, strips adParams from
  the player request so no ad is ever scheduled, and skips any ad that still plays)
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
# Our own video-ad list first: it targets the YouTube pre-roll/mid-roll ad
# endpoints specifically, so blocking does not depend on an upstream list being
# current. Resolved through the config.py symlink, so it works no matter where
# the plugin is installed.
_video_ads_list = None
try:
    _cfg_real = os.path.realpath(os.path.join(config_dir, "config.py"))
    _candidate = os.path.join(os.path.dirname(os.path.dirname(_cfg_real)),
                              "config", "blocking", "youtube-ads.txt")
    if os.path.isfile(_candidate):
        _video_ads_list = _candidate
except Exception:
    _video_ads_list = None

c.content.blocking.enabled = True
c.content.blocking.method = "both"      # hosts + adblock filter lists
c.content.blocking.hosts.block_subdomains = True
c.content.blocking.adblock.lists = [
    *([_video_ads_list] if _video_ads_list else []),
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
config.bind("<Alt-Shift-u>", "pass-fill", mode="insert")  # noqa
config.bind("pw", "pass-fill", mode="normal")  # noqa
config.bind("pt", "pass-totp", mode="normal")  # noqa  TOTP into focused field
config.bind(",kp", "pass-setup", mode="normal")  # noqa  KePassXC browser setup

# ---------------------------------------------------------------------------
# Keybindings
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Short aliases — what the keyhint popup (press "," and wait) and :bind show
# is the raw command string of the binding, so each plugin action gets a short
# readable alias instead of e.g. a whole jseval blob.
# ---------------------------------------------------------------------------
c.aliases.update({  # noqa: F821
    'youtube': 'open https://youtube.com',
    'twitch': 'open https://twitch.tv',
    'ai-site-fix': 'spawn --userscript qute-ai-fix',
    'dark-mode-toggle': 'config-cycle colors.webpage.darkmode.enabled true false',
    'pass-fill': 'spawn --userscript qute-keepassxc-fill',
    'pass-setup': 'spawn --userscript qute-keepassxc-setup',
    'pass-totp': 'spawn --userscript qute-keepassxc-fill --totp',
    'reader-factcheck': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.factcheck();}})()',
    'reader-factcheck-all': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.factcheckall();}})()',
    'reader-focus': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.focus();}})()',
    'reader-mark': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.mark();}})()',
    'reader-mark-all': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.markAll();}})()',
    'reader-next': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.next();}})()',
    'reader-open': 'spawn --userscript qute-reader',
    'reader-open-article': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.wheelopen();}})()',
    'reader-para-summary': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.summarypara();}})()',
    'reader-prev': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.prev();}})()',
    'reader-score': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.score();}})()',
    'reader-summary': 'jseval -q (function(){var r=window.omarchyReader;if(r){r.summarize();}})()',
    'yt-dl-mp3': 'spawn --userscript qute-yt-dl mp3',
    'yt-dl-video': 'spawn --userscript qute-yt-dl video',
    'zoom-in': 'spawn --userscript qute-zoom in',
    'zoom-load': 'spawn --userscript qute-zoom load',
    'zoom-out': 'spawn --userscript qute-zoom out',
    'zoom-reset': 'spawn --userscript qute-zoom reset',
})

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
config.bind(",dt", "dark-mode-toggle", mode="normal")  # noqa  toggle dark mode

# Hint mode: open in new tab
config.bind("F", "hint all tab", mode="normal")  # noqa

# Quick shortcuts: ,y YouTube, ,t Twitch
config.bind(",y", "youtube", mode="normal")  # noqa
config.bind(",t", "twitch", mode="normal")   # noqa

# yt-dlp download (floating terminal with live progress)
config.bind(",dv", "yt-dl-video", mode="normal")  # noqa  download video
config.bind(",dm", "yt-dl-mp3", mode="normal")  # noqa  download MP3

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
config.bind(",af", "ai-site-fix", mode="normal")  # noqa  AI fix this site

# Reader mode — distraction-free article view (Readability) with local-AI
# per-paragraph / whole-article "possibly AI-written" marking and a summary.
config.bind(",r", "reader-open", mode="normal")  # noqa  reader mode

# Reader page actions (guarded: they no-op unless the current page is the reader).
# qutebrowser swallows page key events in normal mode, so the reader's own
# keyboard shortcuts only work in insert mode — these drive them from a keybinding.
config.bind(",n", "reader-next", mode="normal")  # noqa  reader: next
config.bind(",N", "reader-prev", mode="normal")  # noqa  reader: previous
config.bind(",f", "reader-focus", mode="normal")  # noqa  reader: focus
config.bind(",m", "reader-mark", mode="normal")  # noqa  reader: AI-score this paragraph
config.bind(",M", "reader-mark-all", mode="normal")  # noqa  reader: AI-score all paragraphs
config.bind(",s", "reader-summary", mode="normal")  # noqa  reader: summarize article
config.bind(",S", "reader-para-summary", mode="normal")  # noqa  reader: summarize paragraph
config.bind("<Ctrl+Up>", "reader-para-summary", mode="normal")  # noqa  summarise the current paragraph
config.bind(",e", "reader-score", mode="normal")  # noqa  reader: AI score
config.bind(",c", "reader-factcheck", mode="normal")  # noqa  reader: fact-check paragraph
config.bind(",o", "reader-open-article", mode="normal")  # noqa  reader: open focused article
config.bind(",O", "reader-factcheck-all", mode="normal")  # noqa  reader: fact-check whole article
# Enter opens the focused supporting-article preview (no-op off the reader).
config.bind("<Enter>", "reader-open-article", mode="normal")  # noqa

# Per-domain zoom persistence
# qutebrowser does not expose the current zoom to userscripts, so zoom is
# remembered by stepping with ,z+ / ,z- (which apply AND save the new level).
# ,z+ = zoom in one step (remembered)   ,z- = zoom out one step (remembered)
# ,zl = apply the saved level           ,zr = forget domain, back to 100%
# gd  = convenience alias for ,zl
config.bind(",z+", "zoom-in", mode="normal")  # noqa
config.bind(",z-", "zoom-out", mode="normal")  # noqa
config.bind(",zl", "zoom-load", mode="normal")  # noqa
config.bind(",zr", "zoom-load", mode="normal")  # noqa
config.bind("gd", "zoom-load", mode="normal")  # noqa

# ---------------------------------------------------------------------------
# Per-domain tweaks
# ---------------------------------------------------------------------------
config.set("content.autoplay", True, "*.youtube.com")                    # noqa
config.set("content.autoplay", True, "*.twitch.tv")                       # noqa
config.set("content.notifications.enabled", True, "*.github.com")         # noqa

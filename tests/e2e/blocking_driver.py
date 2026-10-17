#!/usr/bin/env python3
"""e2e driver: load the repo's OWN filter lists into the REAL adblock engine.

qutebrowser blocks with Brave's adblock-rust (`adblock` python binding). This drives
that exact engine over the shipped lists and reports what it decides, so the claim
"we block these trackers" is checked against the engine that actually runs — not
against a hand-rolled regex.
"""
import pathlib
import sys

try:
    import adblock
except Exception as exc:  # pragma: no cover - reported to the shell as a skip
    print("E2E NOADBLOCK=1")
    print("E2E ERROR=%s" % exc)
    sys.exit(1)

REPO = pathlib.Path(__file__).resolve().parents[2]
LIST_DIR = REPO / "config" / "blocking"

filter_set = adblock.FilterSet()
loaded = []
rule_count = 0
for name in ("youtube-ads.txt", "trackers.txt"):
    path = LIST_DIR / name
    if path.is_file():
        text = path.read_text()
        filter_set.add_filter_list(text)
        loaded.append(name)
        rule_count += sum(1 for ln in text.splitlines()
                          if ln.strip() and not ln.lstrip().startswith(("!", "[")))

engine = adblock.Engine(filter_set)


def blocked(url, source="https://news.example/", rtype="script"):
    result = engine.check_network_urls(url, source, rtype)
    return bool(result.matched and result.exception is None)


# ── must be blocked (our lists claim to block these) ─────────────────────────
MUST_BLOCK = {
    "GA":            "https://www.google-analytics.com/collect",
    "GTM":           "https://www.googletagmanager.com/gtm.js?id=GTM-ABC",
    "DOUBLECLICK":   "https://googleads.g.doubleclick.net/pcs/view",
    "FB_PIXEL":      "https://connect.facebook.net/en_US/fbevents.js",
    "CRITEO":        "https://static.criteo.net/js/ld/publishertag.js",
    "HOTJAR":        "https://static.hotjar.com/c/hotjar-1234.js",
    "CLARITY":       "https://www.clarity.ms/tag/abcd1234",
    "TABOOLA":       "https://cdn.taboola.com/libtrc/site/loader.js",
    "SCORECARD":     "https://sb.scorecardresearch.com/beacon.js",
    "SEGMENT":       "https://cdn.segment.com/analytics.js/v1/key/analytics.min.js",
    "FINGERPRINT":   "https://api.fpjs.io/v3/identify",
    "MIXPANEL":      "https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js",
    "LINKEDIN_PX":   "https://px.ads.linkedin.com/collect",
    "TIKTOK":        "https://analytics.tiktok.com/i18n/pixel/events.js",
    "TAG_MANAGER":   "https://tags.tiqcdn.com/utag/site/main/utag.js",
    # youtube-ads.txt (regression: the video-ad list must keep working)
    "YT_PAGEAD":     "https://www.youtube.com/pagead/interaction/",
    "YT_MIDROLL":    "https://www.youtube.com/get_midroll_info?params=x",
}

# ── must NOT be blocked (over-blocking breaks the sites we use) ──────────────
MUST_ALLOW = {
    "SITE":          "https://news.example/article/post-1",
    "YOUTUBE_WATCH": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "YT_IMAGE":      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "GOOGLEVIDEO":   "https://rr1---sn-abc.googlevideo.com/videoplayback?id=1",
    "WIKIPEDIA":     "https://en.wikipedia.org/wiki/PDF",
    "GDOCS":         "https://docs.google.com/document/d/abc/edit",
}

for key, url in MUST_BLOCK.items():
    print("E2E BLOCK_%s=%s" % (key, "ok" if blocked(url) else "no"))
for key, url in MUST_ALLOW.items():
    print("E2E ALLOW_%s=%s" % (key, "ok" if not blocked(url) else "no"))
print("E2E LOADED=%s" % ",".join(loaded))
print("E2E RULES=%d" % rule_count)

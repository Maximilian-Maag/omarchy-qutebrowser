# Ad and tracker blocking

qutebrowser does the blocking; this plugin chooses the lists and ships two of its own.
Everything lives in `config/config.py` under the *Ad blocking* section and in
`config/blocking/`.

## How a request is blocked

`content.blocking.method = "both"` turns on two independent blockers:

- **hosts** — `content.blocking.hosts.lists`, a DNS-style list of blocked hostnames;
- **adblock** — `content.blocking.adblock.lists`, ABP/filter-list syntax, parsed and
  evaluated by **Brave's adblock-rust** (the `adblock` python binding qutebrowser uses
  since 3.x).

The engine is asked one question per request — *block or not*. qutebrowser does **not**
wire `$removeparam` (or any URL-rewriting action), so a rule whose only action is to strip
query parameters never runs. Tracker blocking here is therefore **domain blocking**, not
URL rewriting.

## The list set

Our own lists come **first**, so they apply even when nothing upstream is reachable:

| List | What it covers |
| --- | --- |
| `config/blocking/youtube-ads.txt` | YouTube pre-roll/mid-roll ad endpoints, DoubleClick, AdSense, GTM. `googlevideo.com` is deliberately *not* blocked — that is the video CDN. |
| `config/blocking/trackers.txt` | ~90 unambiguous tracker/telemetry domains: analytics, session replay, fingerprinting / identity resolution, ad exchanges, social pixels, tag managers. |

Then the upstream lists add breadth:

- **Ads / general** — EasyList, AdGuard Base (without the EasyList overlap), uBlock
  Origin `filters`, `quick-fixes`, `badware`, `resource-abuse`.
- **Tracking / privacy** — EasyPrivacy, AdGuard Tracking Protection, uBlock `privacy`,
  uBlock `social`, Fanboy Social.
- **Regional** — EasyList Germany.
- **Annoyances** — Fanboy Annoyance, uBlock `annoyances` and `annoyances-cookies`,
  Fanboy Cookie Monster, AdGuard Annoyances.
- **Crypto-mining** — NoCoin.
- **Safety net** — uBlock `unbreak` (re-allows what a site needs to work).

Hosts-level blocking adds StevenBlack, haGeZi's **Pro** list, Peter Lowe and Dan Pollock.

## Why ship our own lists

The same reason as for `youtube-ads.txt`: blocking the well-known trackers should not
depend on an upstream list being current, reachable, or cached at all. The two shipped
lists are versioned with the plugin and are the first entries in the list set, so a fresh
install or an offline machine still blocks Google Analytics, the Facebook pixel, Criteo
and friends.

They are deliberately limited to **unambiguous** trackers. Anything that is also
site-functionality is left to the upstream lists (which carry per-site exceptions and are
paired with `unbreak.txt`), and any single site that still needs one can be handled with a
per-site `content.blocking` override.

## Updating

qutebrowser caches the *parsed* lists (`~/.local/share/qutebrowser/adblock-cache.dat`) and
the hosts list (`blocked-hosts`). After a plugin change:

```
:config-source        # re-read config.py (adds the lists)
,ab                   # :adblock-update — re-download and re-parse
```

`:adblock-update` is also what refreshes the lists over time; run it after a plugin
update, and periodically if you want the upstream lists current.

## How it is tested

`tests/e2e/test_blocking_e2e.sh` (with `tests/e2e/blocking_driver.py`) loads the two
shipped lists into the **real** adblock engine and asserts:

- 17 known tracker/ad endpoints (Google Analytics, GTM, DoubleClick, the Facebook pixel,
  Criteo, Hotjar, Clarity, Taboola, comScore, Segment, fingerprinting, Mixpanel, the
  LinkedIn/TikTok pixels, a tag manager, and two YouTube ad endpoints) are blocked; and
- 6 real-content URLs (the page itself, YouTube watch, a YouTube image, the googlevideo
  CDN, Wikipedia, Google Docs) are **not** blocked.

That is what caught two real gaps while this list was written — Mixpanel's CDN is
`mxpnl.com`, not `mixpanel.com`, and Tealium's is `tiqcdn.com`, not `tealiumiq.com`; the
rules looked right and blocked nothing. A malformed rule in one of our lists is dropped
silently by the engine, so this check runs against the engine, not against a regex.

`tests/test_regression_qutebrowser.py` pins the wiring (the shipped lists are in the list
set) and that every rule in our files is a `||domain^` rule.

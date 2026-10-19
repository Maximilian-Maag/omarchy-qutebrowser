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
  Origin `filters`, `quick-fixes`, `general`, `badware`, `resource-abuse`.
- **Tracking / privacy** — EasyPrivacy, AdGuard Tracking Protection, uBlock `privacy`,
  Fanboy Social.
- **Regional** — EasyList Germany.
- **Annoyances** — Fanboy Annoyance, uBlock `annoyances` and `annoyances-cookies`,
  Fanboy Cookie Monster, AdGuard Annoyances.
- **Crypto-mining** — NoCoin.
- **Safety net** — uBlock `unbreak` (re-allows what a site needs to work).

Hosts-level blocking adds StevenBlack, **haGeZi Pro** (its `wildcard/*-onlydomains.txt`
list — haGeZi no longer ships a `hosts/` directory, and qutebrowser's hosts parser accepts
the one-domain-per-line form directly), **Frogeye's first-party-tracker** list, Peter Lowe
and Dan Pollock.

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

## Diagnosing over-blocking: `,af` (qute-ai-fix)

Blocking has a failure mode the list set cannot see from the inside: it drops a resource the
page actually needs, and you get a blank or half-dead page with no cookie banner to explain it.
The `,af` AI-fix userscript now checks for exactly that. Alongside its cosmetic analysis it runs
`bin/ai-fix-overblocking`, which:

- collects the page's own subresources (script / link / iframe `src`, and `fetch()` / `import()` /
  XHR URLs inside inline scripts) from the live DOM qutebrowser
  serialises for a userscript;
- asks the **real** adblock engine about our two shipped lists and matches the hostnames in
  qutebrowser's parsed `blocked-hosts` (the union of the configured hosts lists);
- reads the on-page signatures of an **anti-adblock wall** and of a **bot-detection interstitial**
  (Cloudflare / DataDome) — a bot challenge is *not* over-blocking, and saying so is half the
  value, because a fingerprint refusal and a blocked page look identical.

It returns a verdict (`over-blocking likely` / `some page resources blocked` / `anti-adblock wall
detected` / `bot-challenge` / `clean`), which the userscript records in the fix file under
`js_overblocking` and reports in the message bar. The evidence is also handed to the model, which
is told not to attribute a bot challenge or a blocked network request to a CSS defect.

Caveat, stated so it is not mistaken for a guarantee: the check covers the **hosts** blocker and
our **own** lists. The large upstream filter lists are cached in a binary form
(`adblock-cache.dat`) that cannot be re-read here, so a rule from EasyList/uBlock that over-blocks
is not caught — the hosts lists are the aggressive ones that most often do.

```text
,af                    # on the broken page; the message bar shows the blocking verdict
```

The tool is testable on its own, too:

```text
QUTE_URL=https://www.example/ QUTE_HTML=/tmp/page.html bin/ai-fix-overblocking
```

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

`tests/e2e/test_blocking_urls_e2e.sh` fetches **every list URL config.py configures** and
fails on a 404/410 — a dead list URL is invisible everywhere else, and qutebrowser reports
it only as a 404 in the status bar during `:adblock-update`. Two bad URLs (`uAssets/filters/
social.txt`, which does not exist, and haGeZi's removed `hosts/pro.txt`) shipped exactly
that way and this check is the guard. It SKIPs when the network itself is unreachable.

`tests/test_regression_qutebrowser.py` pins the wiring (the shipped lists are in the list
set) and that every rule in our files is a `||domain^` rule.

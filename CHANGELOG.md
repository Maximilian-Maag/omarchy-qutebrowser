# Changelog

All notable changes to omarchy-qutebrowser are documented here.

## [1.13.0] — 2026-10-08

### Changed — no more video ads
- **The player request no longer carries ad parameters.** YouTube builds its ad
  schedule from `adParams` / `adBreakParams` / `adSlots` / `adPlacements` /
  `adSignalsInfo` in the outgoing `/youtubei/v1/player` call. Those are now
  stripped from the request body (XHR *and* fetch) before it leaves the browser, so
  no pre-roll or mid-roll ad is ever scheduled — previously an ad was only skipped
  after YouTube had already prepared it.
- New `config/blocking/youtube-ads.txt`: 15 network rules for the YouTube ad
  endpoints plus DoubleClick/AdSense/GTM, wired in as the **first** entry of
  `content.blocking.adblock.lists` so blocking does not depend on an upstream list
  being current. `googlevideo.com` is deliberately not blocked — that is the video
  CDN itself.
- The dropped-request list also covers `ads.youtube.com`, `2mdn.net`,
  `googletagservices`/`googletagmanager`, `/youtubei/v1/player/ad_break` and
  `/youtubei/v1/log_event`.

### Upgrading
Run `:config-source` and then `,ab` (`:adblock-update`) once: qutebrowser caches its
parsed filter lists, so a newly added list only takes effect after that refresh.

Verified ad hoc in a real engine: the outgoing player request loses every ad
parameter while `videoId`/`context`/`playbackContext` survive (both XHR and fetch),
the ad endpoint is still rewritten to `about:blank`, qutebrowser loads the new list
as its first adblock list, and every rule is a network rule that leaves googlevideo
alone. Not verified end to end: a live blocked request — the sandbox reused
qutebrowser's cached parsed rules from before the new list existed, so that check
was inconclusive.

## [1.12.0] — 2026-10-08

### Added
- **Reader: per-article persistence.** Your annotations and where you were are now
  saved server-side, keyed by the article URL, and restored when you reopen or
  reload it: per-paragraph AI scores/verdicts, paragraph summaries, fact-check
  verdicts and their supporting-article wheels, the whole-article summary (with its
  advertorial warning), the paragraphs you hid with `←←`, and the reading position
  (the paragraph you were actually looking at, not just the focused one). New
  endpoints `GET/POST /state` store one JSON file per URL under
  `~/.local/state/omarchy-qutebrowser/reader/article-state/` (0600, pruned after
  half a year).
  Why server-side: the reader is served from a random loopback port, so
  localStorage would be a different origin on every run.

### Fixed
- Reader: a fresh load could **overwrite the saved state with an empty one** — the
  initial `setActive(0)` scheduled a debounced save that raced the restore.
- Reader: leaving the page could **clobber the state right after a reload** (the
  unload save raced the next load's read). Saves are now change-detected and sent
  as a `navigator.sendBeacon`, so an unchanged page never overwrites anything.
- Reader: rebuilding the article (which happens when you hide AI paragraphs) wiped
  the "AI 20%" text off every verdict badge — badges are re-written from the saved
  state after each rebuild.

## [1.11.0] — 2026-10-08

### Changed
- **Keybindings now use short aliases** so the keyhint popup (press `,` and wait)
  and `qute://bindings` show readable names instead of raw one-line command blobs:
  `,dt` → `dark-mode-toggle`, `,dv` → `yt-dl-video`, `,dm` → `yt-dl-mp3`,
  `,r` → `reader-open`, `,e` → `reader-score`, `,s` → `reader-summary`,
  `,af` → `ai-site-fix`, `,z*` → `zoom-*`, `pw` → `pass-fill`, … 23 aliases.
  (qutebrowser's `config.bind()` has no `desc` argument — the binding text IS the
  representation, so the fix is to bind to short alias names.)

### Fixed
- **yt-dlp downloads no longer depend on the terminal window.** `,dv`/`,dm` used to
  run yt-dlp *inside* the floating terminal, so when that window closed or never
  mapped, nothing landed in `~/Downloads`. yt-dlp now runs detached in its own
  session writing a live log (`~/.local/state/omarchy-qutebrowser/yt-dl/latest.log`)
  and the terminal merely tails it; closing the window is harmless, the outcome is
  recorded in the log, and a desktop notification fires on success/failure. The
  format selector became `bv*+ba/b` because the old mp4-only selector failed with
  "Requested format is not available" on videos offered only as m3u8/webm.
- **Cookie consent is now reject-by-default** (`cookie-banner-remover.js` v4.0):
  a reject button is always preferred, an accept button is clicked *only* when the
  banner offers no reject option, and a banner with no buttons at all is simply
  removed. Small consent *bars* (much under the old 25 %-viewport overlay
  threshold) are now detected by their button labels, and button-less consent
  strips by their text.
- **Anti-adblock defusing** (same script): filter lists block ads, sites detect it
  by measuring a "bait" element or reading `window.adsbygoogle`/`canRunAds`, then
  cover the article with a "please disable your ad blocker" wall (bild.de and many
  German news sites). The script makes the usual baits measure like served ads,
  sets the usual flags, and removes the wall plus its scroll lock if one appears.
- **YouTube**: more ad fields stripped from player responses
  (`clientSideAdBreakParams`, `adBreakServiceRenderer`, `playerAdParams`,
  `adThrottled`), `/get_midroll_info` dropped, and an eager 250 ms poll for the
  first 90 s so a pre-roll that starts before any observable mutation is caught.

Verified ad hoc in a real engine: consent decisions (reject wins, accept as
fallback, remove when button-less, German "Nur notwendige"), wall removal +
scroll unlock, the YouTube ad-kill path (overlay removed, force-ended, 16× blast,
viewer's 1.5× speed restored), a real yt-dlp download landing while the terminal
was a stub that exited immediately, and that every binding resolves to a defined
alias.

## [1.10.0] — 2026-10-06

### Added
- **Advertorial / paid-coverage warning** in the whole-article AI summary. The
  summary call now also judges whether the piece reads as paid or promotional
  content and returns `{"promotional": {"score", "kind", "evidence"}}` alongside
  the summary, AI-ness verdict and reason. The reader shows a warning at the top
  of the summary block when the score is ≥ 40 — "⚠ Probably paid or promotional
  content" (≥ 70, red) or "⚠ Some commercial-marketing signals" (amber) — naming
  the kind (advertorial / sponsored / native ad / affiliate / PR / brand content),
  the confidence, and the concrete signal (a disclosure label, a call to action,
  unopposed brand praise…). The status line repeats it. Verified with real model
  calls: an undisclosed German advertorial scored 96/"advertorial" and rendered the
  warning above the bullets; a neutral council-budget report scored 5/"none" and
  was not flagged.

## [1.9.3] — 2026-10-06

Second round of the deep-dive sweep (a parallel read-only review of the scripts).

### Fixed
- `userscripts/youtube-adblock.js`: after an ad the script forced `playbackRate`
  back to exactly 1×, so anyone watching at 1.5×/2× was silently dropped to normal
  speed on every pre-/mid-roll ad. The viewer's own rate is remembered and restored.
- `userscripts/youtube-adblock.js`: `if (!clickSkip()) forceEnd(video); else
  forceEnd(video);` — both branches identical; the dead branch is gone.
- `userscripts/cookie-banner-remover.js`: the generic overlay sweep looped
  `document.body.children`, a LIVE HTMLCollection, while `el.remove()` shifted it —
  so a second qualifying overlay was skipped for that pass. It iterates a snapshot.
- `userscripts/qute-keepassxc-fill`: cancelling the account picker (Esc) blocked
  for the whole 60 s deadline. The shell's `> outfile` truncates the output file the
  moment the terminal launches, so "the file has content" never became true; the
  shell now writes a done-marker when gum exits, so a cancel returns at once.
- `userscripts/qute-keepassxc-fill`: a reply larger than a single `recv()` (a
  `get-logins` with many matching entries) was parsed from one fragment and could
  fail; the reply is now read until it parses, with a clear error if it never does.

## [1.9.2] — 2026-10-06

### Fixed
- `qute-keepassxc-fill`: **password fill never worked.** It wrote the fill script
  (81 lines) to qutebrowser's userscript FIFO, and qutebrowser executes that FIFO
  one line per command (`qutebrowser/commands/userscripts.py`: the Fifo object
  emits `got_line` for every line). So only `jseval ` — with no JS — was run, and
  every following JS line was parsed as an unknown command. The JS is now collapsed
  onto a single line (comments stripped first; whitespace inside string literals
  preserved), and `qute()` refuses a command containing a newline so this cannot
  silently regress again. Verified end-to-end in a real engine: a login form ends
  up with the username and password filled and a hidden decoy left untouched.
- `install.sh`: now checks that the `python3` qutebrowser will actually use for the
  fill userscript can import `nacl`. `python-pynacl` is installed for the system
  interpreter, but the userscript's `#!/usr/bin/env python3` resolves via PATH
  (e.g. a mise shim), so the two can diverge — that is now reported at install time
  instead of showing up as "pw does nothing".

## [1.9.1] — 2026-10-06

Deep-dive bug sweep. No behaviour changes intended.

### Fixed
- Reader: per-paragraph AI state (verdicts, fact-check cards, article wheels) was
  keyed by paragraph INDEX. Inserting the AI summary or removing AI-written
  paragraphs shifts every index, which could attach a verdict to the wrong
  paragraph and make `→`/focus fail. Everything asynchronous now carries the block
  element and re-resolves its index, stored in WeakMaps.
- Reader: the paragraph highlight followed the *index*, so after a rebuild the
  wrong paragraph stayed lit. It now follows the element.
- Reader: the whole-article summary, whole-article fact-check and "mark AI text"
  fed the AI summary block back in as if it were article text, contaminating the
  next result. Real article paragraphs are used now.
- `config/themes.py`: `_alpha()` raised on any colour that was not a 6-digit hex
  (3-digit hex, `rgb(...)`, a named colour), which aborted the ENTIRE config load
  for a user theme that used one. It now expands 3-digit hex and passes anything
  else through unchanged.
- `bin/reader-server`: `server.json` (a bearer token for the loopback server — any
  local user can reach 127.0.0.1) was world-readable; it is now 0600, and the state
  and article directories are 0700. Article ids are validated against the exact
  format the userscript generates, and oversized `/ai` payloads are rejected before
  being read.
- `userscripts/qute-reader`: article HTML/meta were copies of the source file, so
  they inherited its permissions; they are created 0600 now. Two rapid `,r` presses
  could each start a reader-server and orphan the loser — a lock now serialises
  startup. The log file handle was also leaked on each start.

## [1.9.0] — 2026-10-06

### Added
- Reader: **`↑` on the first paragraph summarises the whole article** (there is no
  paragraph above to move to), and **`Ctrl+↑` summarises just the current
  paragraph** — one sentence, shown as a card under it. `,S` does the same.
- `bin/reader-server`: `summary_para` mode (one-sentence paragraph summary).

### Changed
- Reader: **`←` while the supporting-article wheel is focused leaves the wheel and
  returns to the paragraph** (instead of scoring it). `Esc` still works too.
- Reader: the verdict card / article wheel now sit in side padding that `#article`
  *reserves*, so they no longer overflow the window or cover the text when the
  window is not full-screen; below 1180px they flow inline under the paragraph.
- Reader: `↑` navigation is instant again (the paragraph summary moved to Ctrl+↑).

### Fixed
- Reader: rebuilding the paragraph list (e.g. after adding the summary) left the
  previous paragraph highlighted as well — stale `.active` state is now cleared on
  rebuild and the current paragraph stays lit.
- `Ctrl+↑` is bound as `<Ctrl+Up>`: qutebrowser rejects `<Ctrl+ArrowUp>` as an
  invalid key name (the page-side handler still uses the DOM name `ArrowUp`).

## [1.8.0] — 2026-10-06

### Added
- Reader double-tap actions: **`←←` removes the AI-written paragraphs** (with an
  *Undo* button to restore them) and **`→→` fact-checks the whole article** in one
  pass (one news search per paragraph, one model call).
- Reader fact-check presentation: the **verdict card sits to the LEFT of the
  paragraph** and a **wheel of supporting articles to the RIGHT**. Press `→` to
  focus the wheel, scroll previews with `↑`/`↓` (or `,n`/`,N`, or the mouse wheel)
  and press **Enter** (or `,o`, or *Open ↵*) to open the focused article in a new
  tab. Falls back to an in-flow layout under 1250px.
- New keybindings `,o` (open focused preview), `<Enter>` (same) and `,O`
  (whole-article fact-check).
- `bin/reader-server`: `factcheck_article` mode plus `_headlines_for` memoisation.

### Changed
- Reader fact-check results are stored per paragraph, so a whole-article run shows
  a verdict card next to every checked paragraph.

## [1.7.0] — 2026-10-06

### Added
- Reader: **per-paragraph AI score** (`◀ AI score` button / `←` key / `,e`) and
  **fact-check against other news outlets** (`Fact-check ▶` button / `→` key /
  `,c`). Fact-check pulls Google News RSS (German + English) for the paragraph's
  key terms and asks the local model whether other outlets corroborate or
  contradict it, then shows the verdict, confidence, reason and the matching
  headlines/outlets in a card below the paragraph.

### Changed
- Reader: the AI summary is now a **focusable block rendered above the title** and
  part of paragraph focus, so `↑` from the headline reaches it (it used to be a
  side panel that focus navigation skipped).
- Reader: the per-paragraph `AI?` button / score chip now sit in a **reserved
  right gutter** beside the text instead of overlapping the paragraph.

## [1.6.0] — 2026-10-06

### Changed
- YouTube ad-block rewritten (userscript v3.0) so **pre-roll / mid-roll video ads**
  are stopped, not just their DOM:
  - strips `adPlacements` / `playerAds` / `adSlots` / `adBreakHeartbeatParams`
    out of the player response *before YouTube's player reads it* — via a
    `document-start` setter on `window.ytInitialPlayerResponse` / `ytInitialData`,
    and by rewriting the `/youtubei/v1/player` (+ `/next`) fetch and XHR bodies.
    The XHR hook patches at `readystatechange`/readyState 4, which fires *before*
    the site's own `onload` (patching on `loadend` is too late).
  - drops ad/analytics requests (`adformat=`, `/api/stats/ads`,
    `/pcs/activeview`, pagead/ptracking/doubleclick…).
  - fallback for anything that still plays: click Skip, else jump to the ad's end
    and speed the player up, restoring the rate when the ad ends.
  - more ad surfaces covered, incl. the "ad blocker detected" wall.

## [1.5.0] — 2026-10-06

### Added
- **Video-download picker.** `,dv` / `,dm` on a page that is *not* itself a video
  (YouTube search results, a channel, any list) now show qutebrowser hints on the
  new `ytdl` link group so you choose which video to download; on a video page the
  current video is grabbed directly. Rapid hinting, so you can queue several
  (Esc to cancel).

### Changed
- `qute-keepassxc-fill` runs the fill JS *without* `-q`, so qutebrowser shows the
  real result — `filled:username+password`, `filled:username` on the Google /
  Microsoft first step, or `no-fields` on an account chooser — instead of always
  reporting success.

### Fixed / verified
- `,dt` dark-mode toggle confirmed working after the `,d` → `,dt` rename (the
  command `config-cycle colors.webpage.darkmode.enabled true false` toggles live).
- The `ytdl` hints group is registered by mutating `c.hints.selectors` — dotted
  `config.set('hints.selectors.ytdl', …)` is rejected by qutebrowser
  ("No option 'hints.selectors.ytdl'").

## [1.4.0] — 2026-10-06

### Added
- Reader: paragraph navigation (`↑`/`↓` buttons and `,n`/`,N` keys), text-size
  controls (`A−`/`A+`), and `,n` `,N` `,f` `,m` `,M` `,s` keybindings that drive
  the reader page from qutebrowser's normal mode (guarded, no-op elsewhere). The
  per-paragraph `AI?` button is now always visible (was hover-only).
- Cookie-banner remover rewritten (v3.0): explicit selectors for the major CMPs
  — **Sourcepoint** (golem.de, heise.de), OneTrust, Cookiebot, Usercentrics,
  Didomi, CCM19, Borlabs, Klaro, consentmanager, Quantcast, iubenda, Osano,
  TrustArc, Google Funding Choices, CookieYes, Complianz, CookieFirst, Cookiehub,
  CookieScript … — plus a generic fixed-overlay fallback and removal of the
  scroll-lock classes CMPs add (`sp-message-open`, `didomi-popup-open`,
  `ccm-blocked`, …). Verified against golem.de and heise.de.

### Fixed
- Reader no longer nests reader-inside-reader when `,r` is pressed on a reader
  page (it refuses with a message).

## [1.3.3] — 2026-10-06

### Fixed
- **`,dm` and `,dv` (yt-dlp downloads) never fired.** qutebrowser's keybinding
  trie returns an ExactMatch the moment a node has a command, *without* checking
  longer children, so a binding that is a prefix of another shadows it. The `,d`
  dark-mode toggle therefore swallowed `,dm`/`,dv` — pressing `,dm` ran `,d`
  (dark mode) then `m` (default `quickmark-save`, i.e. "set bookmark"), and `,dv`
  ran `,d` then `v` (default caret mode, which errors). The dark-mode toggle is
  now **`,dt`**. Verified against qutebrowser's real `BindingTrie`: no binding is
  shadowed by a shorter prefix any more.

## [1.3.2] — 2026-10-06

### Changed
- Dropped a redundant `content.headers.referer = "same-domain"` from config.py
  (it is qutebrowser's default and a global-only setting); documented instead.
- README: note the bundled `aether` palette (23 palettes total) alongside the
  22 stock themes.

## [1.3.1] — 2026-10-06

### Fixed
- **Per-domain zoom was non-functional.** qutebrowser does not export the
  current zoom to userscripts (there is no `QUTE_ZOOM`), so `,z` always saved
  100%; and `:zoom` takes an integer percentage, so `,zl`/`,zr` emitted an
  invalid `zoom 1.5`. `qute-zoom` now *owns* the zoom level: `,z+`/`,z-` step
  through the ladder and remember the level, `,zl` (alias `gd`) applies it, and
  `,zr` resets to 100%. Legacy factor values in `zoom.json` migrate on read.
- KeePassXC multi-account picker ran `fzf` even after `gum` succeeded (shell
  `||`/`&&` precedence) — no fallback chain now.
- Per-site fixes: a single invalid uBlock cosmetic selector (procedural pseudos
  like `:has-text()`) could invalidate the whole comma-joined hide rule and drop
  every other hide; each selector is now emitted as its own rule and procedural
  selectors are filtered out.
- The initial theme seeded by `install.sh` normalised spaces differently from
  the `theme-set` hook (`` `tokyo night` `` vs `tokyo-night`), showing the wrong
  palette for multi-word themes until the next theme switch.
- Reader page now sends `Referrer-Policy: no-referrer` so its session token
  cannot leak to third-party article-image hosts.
- `qute-keepassxc-setup` no longer false-positives "KeePass2 (Mono)" via
  `pgrep -f keepass` matching its own cmdline.
- Cookie-banner remover's scroll-position restore was dead code; it now
  captures the offset before clearing `body.style.position`.
- `qute-keepassxc-fill` reports a clear, actionable error if PyNaCl is missing
  for the interpreter that runs it.

## [1.3.0] — 2026-10-06

### Added
- Reader mode (`,r`): a distraction-free view of the current article, extracted
  with Mozilla Readability and served from a local loopback page
  - paragraph-wise reading: focus mode (`f`) with `j`/`k` / `↑`/`↓` navigation
  - per-paragraph `AI?` button and a whole-article mark (`M`) that ask the
    **local** agent (`hermes -z … --cli`) whether text looks AI-written
    (human / mixed / AI + likelihood), shown as coloured borders and badges
  - AI summary (`s`) with an overall AI-likelihood badge
  - colours follow the active Omarchy theme; no text leaves the machine
- `bin/reader-server`: loopback bridge (127.0.0.1, per-session token) serving the
  reader page and `POST /ai`, which runs the local agent
- `userscripts/qute-reader`: ingests the current page and opens the reader tab
- Bundled `reader/readability.js` (Mozilla Readability, Apache-2.0)

## [1.2.0] — 2026-10-06

### Added
- `qute-keepassxc-fill` userscript (MIT): a robust KeePassXC password/TOTP fill
  that speaks the same KeePassXC-Browser socket protocol and reuses the existing
  association, replacing the bundled `qute-keepassxc` in the `pw` / `Alt+Shift+U`
  bindings and adding `pt` for TOTP
  - fills the username/email field even on a step with no password field, so
    multi-step Google / Microsoft sign-in works (`pw` → Next → `pw`)
  - never writes into hidden / `aria-hidden` / `tabindex=-1` decoy fields
    (Google's identifier page ships a hidden `name="hiddenPassword"`)
  - fills visible password fields only
  - sets values through the native value setter and dispatches
    `input`/`change`/`keyup`/`blur` so React/Vue/Angular register them
  - multi-account selection via `gum`/`fzf` in a floating terminal (rofi absent)

## [1.1.0] — 2026-10-06

### Added
- `qute-yt-dl` userscript: download current page as video (`,dv`) or MP3 (`,dm`) via yt-dlp, with live progress in a floating terminal
- `qute-keepassxc-setup` userscript: first-run guide that checks KeePassXC install, running state, and Browser Integration socket (`,kp`)
- `qute-zoom` userscript: per-domain zoom persistence — save (`,z`), restore (`,zl`), reset (`,zr`)
- `qute-ai-fix` userscript: AI per-site fix engine (`,af`) — analyzes a page and saves per-domain CSS/cosmetic fixes
- Cookie-banner Greasemonkey remover (belt-and-suspenders alongside the filter lists)
- `,p` keybinding: open current URL in a private (temp-profile) window
- Configurable default search engine via `QUTE_DEFAULT_SEARCH` env var
- Configurable start page via `QUTE_START_PAGE` env var
- `bin/set-system-default`: sets qutebrowser at all three MIME layers (user, `/etc/xdg/mimeapps.list`, Omarchy system defaults)
- `bin/set-system-default`: symlinks `/usr/bin/x-www-browser` to qutebrowser

### Fixed
- `downloads.location.ask` → `downloads.location.prompt` (nonexistent option)
- Added `config.load_autoconfig(False)` to silence startup warning
- KeePassXC binding: added `--insecure` flag (no GPG key required)
- YouTube adblock: wrapped fetch/XHR intercepts in try/catch; added `yt-navigate-finish` hook for SPA navigation; guarded `endAd()` against Infinity/NaN video duration
- adblock dependency: install `python-adblock` via pacman (system Python), not pip

### Bug-review fixes
- `qute-ai-fix` no longer appends generated lines to `site-overrides.py` (a symlink into the plugin source) — it only writes the JSON fix file now
- Per-domain fixes are applied through generated per-domain Greasemonkey scripts (`greasemonkey/omarchy-sitefix-<domain>.js`) instead of one global `content.user_stylesheets`, which leaked every site's CSS onto every other site
- `adblock_rules` from `qute-ai-fix` are now actually applied (as domain-scoped cosmetic CSS); previously they were produced and counted but never used
- Removed the dead `site-fixes.js` Greasemonkey script — it read `window.__omarchyFixes`, which nothing ever set
- Fonts: strip the trailing point size from the gsettings monospace font, so `fonts.default_family` gets a real family ("Adwaita Mono", not "Adwaita Mono 11")
- `install.sh`: install `python-pynacl` via pacman, not pip (qutebrowser runs on the system Python)
- `qute-ai-fix`: pass the URL/domain to Python as argv instead of interpolating into a `python -c` string
- `qute-zoom`: honor `XDG_STATE_HOME` (was hardcoded to `~/.local/state`)
- Cookie-banner remover: tightened reject/close button matching — no more bare "no"/"close"/"refuse" matches hitting unrelated buttons
- Dropped the no-op `js_allow` field (`content.javascript.enabled` already defaults to true, so the per-domain "allow" changed nothing)
- Replaced blanket `except: pass` around `config.source` with stderr logging

## [1.0.0] — 2026-10-05

### Added
- Initial release
- 22 Omarchy stock themes (catppuccin, nord, tokyo-night, gruvbox, hackerman, and 17 more) with automatic live switching via `omarchy theme set`
- Theme-set hook: reloads qutebrowser config on theme change via IPC
- Support for user themes under `~/.config/omarchy/themes/<name>/`
- KeePassXC password fill via `qute-keepassxc` userscript (`Alt+Shift+U` / `pw`)
- YouTube ad-free via Greasemonkey script (skip/end pre-roll, remove DOM elements, intercept fetch/XHR)
- Built-in host + Adblock filter-list blocker (EasyList, EasyPrivacy, uBlock Origin, StevenBlack hosts)
- Sets qutebrowser as default browser: user level, system `/etc/xdg/mimeapps.list`, Omarchy `/usr/share/applications/mimeapps.list`
- One-shot `install.sh`

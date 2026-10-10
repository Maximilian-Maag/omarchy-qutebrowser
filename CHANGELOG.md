# Changelog

All notable changes to omarchy-qutebrowser are documented here.

## [1.17.25] — 2026-10-08

### Added
- **A live progress bar for yt-dlp downloads.** The floating terminal used to `tail -f` the
  log, so a download scrolled through hundreds of per-second percentage lines. It now runs
  the userscript's own `--watch` mode, which redraws ONE bar in place:
  `[##############------------------]  45.2%  1.23MiB/s  ETA 00:08`, then shows the tail of
  the log and the outcome when the runner finishes. `--bar "<log line>"` renders a single
  line, which is what makes the bar testable without a live download.

  Found and fixed by running it end to end: `--watch` first hung for 30 s, because `kill -0`
  also succeeds on a **zombie** — a runner that exited without being reaped kept the loop
  alive. It now stops on the runner's own outcome line in the log, treats the pid check as
  secondary, and has an iteration bound as a backstop, so it cannot spin forever.

## [1.17.24] — 2026-10-08

### Fixed
- **The same treatment for Microsoft's sign-in.** The user-agent override and the
  third-party-cookie exception already covered `login.microsoftonline.com`, `login.live.com`
  and `login.microsoft.com`, but the JavaScript detection shims in
  `userscripts/google-signin-compat.js` matched Google hosts only, so Microsoft's pages were
  left without them. Its `@match` list now includes the Microsoft sign-in hosts and
  `account.microsoft.com`. The cookie/adblock script's auth-page guard already covered
  `login.*`; it now also covers `account.*` (singular), which `account.microsoft.com` needed.

## [1.17.23] — 2026-10-08

### Fixed
- **Passkey (WebAuthn) sign-in could never work, and left the sign-in stuck.** QtWebEngine
  carries Chromium's WebAuthn code — the library is full of `PublicKeyCredential` symbols —
  but Qt implements no authenticator service, so the page is offered a passkey and the
  request can only fail. `userscripts/google-signin-compat.js` now reports no public-key
  support on the sign-in hosts, so Google offers its password flow instead, which does work
  there with the fixes from v1.17.20–v1.17.22. The overrides stay redefinable rather than
  locking the native APIs down for other scripts.

  Engine limitation, not a configuration one: no setting can make a passkey work in
  qutebrowser today.

## [1.17.22] — 2026-10-08

### Fixed
- **"Dieser Browser oder diese App ist unter Umständen nicht sicher" on Google sign-in.**
  config.py already sends a real Chrome user agent (the actual QtWebEngine Chromium version,
  140.0.7339.225) to the sign-in hosts, but Google's check also reads JavaScript detection
  signals that an embedded Chromium simply does not have: real Chrome exposes `window.chrome`
  and `navigator.userAgentData`, QtWebEngine exposes neither. Together with the third-party
  cookie exception from v1.17.21, this is the JavaScript-side counterpart.

  New userscript `userscripts/google-signin-compat.js` (document-start, scoped to the Google
  sign-in hosts) provides `window.chrome` with `runtime`/`loadTimes`/`csi`,
  `navigator.userAgentData` with brands matching the advertised version and a working
  `getHighEntropyValues`, and reports `navigator.webdriver` as false. It leaves anything the
  engine already provides untouched. Four tests pin it, including that an existing
  `window.chrome`/`userAgentData` is never clobbered.

## [1.17.21] — 2026-10-08

### Fixed
- **Gmail sign-in failed because third-party cookies were blocked.** The config sets
  `c.content.cookies.accept = "no-3rdparty"`, but Google's sign-in handshake reads cookies in
  a third-party context, so the flow fails — typically as "This browser or app may not be
  secure" or a sign-in that will not complete. Third-party cookies are now allowed for the
  sign-in hosts only (the same list as the user-agent override: accounts.google.com,
  accounts.youtube.com, login.microsoftonline.com, login.live.com, login.microsoft.com);
  everything else keeps the stricter policy.

## [1.17.20] — 2026-10-08

### Fixed
- **Google sign-in (Gmail) was broken by the cookie/adblock userscript.** It matches
  `*://*/*`, so it ran on `accounts.google.com` too, and a sign-in screen is full of buttons
  it would happily click: `ACCEPT_PATTERNS` contained a bare `/agree/i`, so "I agree" and
  "Agree & continue" were candidates — terms buttons on a sign-in or registration page — and
  its generic overlay fallback would remove sign-in overlays. That is how a login breaks.
  Auth pages are now skipped entirely (`accounts.*`, `login.*`, `signin.*`, `auth.*`,
  `sso.*`, `account.google.*`, and `/signin`, `/login`, `/oauth`, `/consent`, `/logout` paths)
  and the bare `/agree/i` is gone in favour of `/agree\s*(and|&)\s*continue/i`. Three tests
  pin it: a Google sign-in page is skipped and nothing is clicked, a `/login` path is skipped,
  and an ordinary page is still acted on. `tests/js/cookie.test.js`: 27 tests pass.

## [1.17.19] — 2026-10-08

### Changed
- **The mutation runner's equivalent-mutant mechanism is now covered by tests.** Its own code
  is a mutation target, and the mechanism had ~6 mutants nothing killed, which held
  `tools/mutator.py` at 0.70. Two tests now pin it: undeclared survivors fail the run, and a
  target whose survivors are all declared meets the bar with `killed == counted`.

  The fixture also documents the trap I fell into: it has **two** survivors on the same line,
  so declaring only one leaves a genuinely unkilled mutant and the run correctly fails.
  Reading `equivalent: 1` beside `counted: 3` as "the filter does not fire" was wrong —
  4 mutants minus 1 excluded is exactly 3. The mechanism had always worked.

## [1.17.18] — 2026-10-08

### Fixed
- **qutebrowser did not follow the Omarchy theme.** Two causes. The plugin keeps its own
  hardcoded palette per theme, and those had drifted from the stock themes — hackerman's
  red was a generic `#ff5555` instead of `#50f872`, and its yellow, cyan, selection, two
  backgrounds and two foregrounds were all wrong. And when no theme name resolved it fell
  back to **catppuccin**, so with the theme state file absent qutebrowser showed a
  completely unrelated theme.
  The applied theme's `colors.toml` — `~/.local/state/omarchy/current/theme/colors.toml` —
  is now the source of truth, overlaid onto the built-in palette so every expected key
  still exists. Any theme, stock or user, is followed exactly. The theme's *name* is
  recovered by matching its colours against the theme directories, because Omarchy applies
  a copy rather than a symlink, so the path is always ".../current/theme". Verified against
  the live theme: zero mismatches, resolved as "hackerman".
- **tests/js/reader.harness.test.js failed the policy's JS check.** `tools/policy_check.py`
  compiles every `.js` file with `new vm.Script`, which treats a file as a script, so the
  file's ESM `import` was a syntax error there even though `node --test` accepted it. It now
  uses `require()`, which is valid under both.

## [1.17.17] — 2026-10-08

### Fixed
- **The mutation runner mutated shell comments.** `code_mask` skipped `#` comments for
  Python and `//`/`/* */` for JS, but explicitly excluded shell — so every comment line in a
  shell target became an unkillable no-op mutant, silently holding its score down. A shell
  `#` now starts a comment at the start of a word only, so `${#var}` and `a#b` remain code.
  `qute-yt-dl` could not have exceeded 17/23 however good its tests were.
- **A test that assumed a tool from the developer's machine.** `tests/shell/test_qute_yt_dl.sh`
  asserted mp3 mode works *with ffmpeg present* — CI has no ffmpeg, so the assertion failed
  there and took the whole target's baseline with it (the runner correctly refused to score
  it rather than reporting a number). Both branches are now asserted, one per environment.
- **The yt-dl shell tests were flaky.** They checked for the download log, which the detached
  runner writes asynchronously, so the target's score moved between runs (0.61–0.74, and one
  inflated 0.83 I reported earlier). They now check the synchronously-written runner first and
  only wait a bounded time for the log. Three consecutive runs: identical.

## [1.17.16] — 2026-10-08

### Fixed
- **The page lurched when entering a supporting-article wheel.** `focusWheel` called
  `el.focus()`, and focusing scrolls the element into view — so stepping into a wheel moved
  the whole page under the reader. Focus now uses `preventScroll: true`, here and wherever
  else the reader focuses a block.
- **A fact-checked paragraph with no corroborating outlets looked identical to a broken
  wheel.** `renderWheel` returned silently when the news search found nothing, so the wheel
  simply never appeared. It now says so: "No supporting articles found for this paragraph".
  (This is the likely shape of "the wheels don't show up": the per-paragraph check is one
  search and usually finds hits, while a whole-article check fires one search per paragraph
  in quick succession, and the ones that come back empty render nothing.)
- **The status page can be opened from the reader.** A Status link in the reader's toolbar
  points at `/status/<this article's id>` — derived from the reader's own URL — so it always
  describes the article being read rather than whatever page is current. `,i` from inside
  the reader could not do this: it re-ingests the *current* page, which is the reader itself.
  Also exposed as `window.omarchyReader.status()`.

## [1.17.15] — 2026-10-08

### Fixed
- **CI: the KeePassXC socket integration tests were skipping silently.** PyNaCl is a real
  runtime dependency of the fill userscript, but CI never installed it, so
  `tests/test_integration_keepassxc_socket.py` skipped every test — and the fill target's
  mutation score read 0.18 in CI while it measures 0.50 locally, because that coverage was
  not running at all. The workflow now installs PyNaCl before the suite. (Found by reading
  the actual CI log rather than trusting the local number.)

## [1.17.14] — 2026-10-08

### Fixed
- **A whole-article fact-check produced no outlet wheels.** `factCheckArticle` rendered each
  paragraph's verdict card but never called `renderWheel`, so the supporting-article wheels
  that sit to the right of a paragraph were missing — they only appeared after a
  single-paragraph check, which does call it. Now every fact-checked paragraph gets its
  wheel, and the status line says → focuses one. Pinned by a test that fails without it.

## [1.17.13] — 2026-10-08

### Added
- **`tests/test_regression_qutebrowser.py`** — six regression tests, each naming the bug it
  pins: publisher names matched by bare substring ("Auto Motor und Sport" → RT/state/low),
  `,zr` bound to `zoom-load` instead of `zoom-reset`, bare `t` shadowing stock `th`/`tl`,
  the generated yt-dl runner being invalid bash and reporting nothing on failure, the
  `max_paras=12` fact-check cap, and the unrecoverable KeePassXC dead association.
- `userscripts/qute-yt-dl` is a mutation target (the regression test regenerates and runs
  its runner). Every remaining source file that is not a target is now listed in
  `tests/mutation.json`'s `exempt` **with a stated reason** — a recorded, visible gap rather
  than an invisible one.

### Fixed
- **CI: the `policy` job is green again.** It had been failing on every push since the
  regression kind was missing and several source files were neither mutated nor exempted.
  `python3 tools/policy_check.py` now reports 44 files, 0 failed, 0 warnings.

## [1.17.12] — 2026-10-08

### Fixed
- **Pressing `m` and then ← deleted paragraphs.** `m`, `←` and the toolbar button all score
  the active paragraph, and they all shared the tap name `left` — whose *double* action is
  destructive (it removes AI-written paragraphs). So two different keys pressed within
  450 ms were read as a double-tap and removed paragraphs instead of scoring twice. Easy to
  hit, because the single action is deferred ~460 ms with no acknowledgement, so pressing
  again "because nothing happened" was the natural thing to do. The tap name now includes
  the key: two presses of the *same* key still mean double, different keys never do. Pinned
  by two tests (different keys do not double; the same key still does).

## [1.17.11] — 2026-10-08

### Fixed
More confirmed findings from the deep-dive audits, each verified.

- **Embedded media was anchored to the wrong place (multimedia).** `collectMedia` counted
  preceding text blocks on the **raw page** — nav, header and footer included — and
  `spliceMedia` applied that index to the **Readability-extracted** article, whose block
  count is smaller. So media usually landed somewhere other than the paragraph it followed,
  and commonly got appended at the very end. Media now carries the nearest preceding block
  **element**, matched by identity (a dropped anchor falls back to the old index, then to
  appending). Two regression tests cover it, including the deliberately-wrong-index case.
- **A second removal pass clobbered the first.** `applyRemoval` replaced `removedAI` and
  `pState.removed` instead of merging, so remove → score → remove again meant Undo restored
  only the latest batch, and after a reload the earlier batch came back while the saved
  state still listed it as removed. Both are merged and deduplicated now.
- **SponsorBlock's "entire video is sponsor" toast fired once ever.** `SB.fullWarnedFor`
  is a global that was never reset, so only the first full-sponsor video warned.
- **A `data:` URL was stored whole as its zoom domain key.** `get_domain` fell back to
  `parsed.path`, which for a `data:` URL is the entire payload; the key is now a bounded
  `scheme:/*` pseudo-domain.

## [1.17.10] — 2026-10-08

### Fixed
- **A dead KeePassXC association was a dead end.** If KeePassXC had restarted, switched
  database or dropped the association, `connect_keepassxc` reported "run again to
  re-associate" and *kept the stale key file* — so running again took the identical branch
  and failed identically. The only recovery was deleting the key by hand. The stale key is
  now removed on a failed `test-associate`, so pressing again genuinely re-associates.
  (Found by an audit; my first attempt at the fix used `store.path.unlink()` and crashed —
  `store.path` is a `str` — which the verification caught before it shipped.)
- **`pw` could hang forever.** The browser socket had no timeout, so a KeePassXC that
  accepted the connection but never answered left the keypress doing nothing at all until
  the process was killed. The socket now times out after 8s, and transport failures are
  reported instead of raising.
- **AI timeouts leaked orphaned processes.** `subprocess.run(timeout=)` kills only the
  direct child, and the model is usually reached through a wrapper — so a timeout left the
  grandchildren running (measured: 5 stray processes from one timeout, accumulating).
  The child now starts in its own session and a timeout kills the whole group. Verified:
  the grandchild does not survive.
- **`tests/js/cookie.test.js` was permanently red on a wrong assertion** — it expected
  `pointer:click`, but `press()` builds a `MouseEvent` for anything not starting with
  "pointer", so `mouse:click` is correct and no code path could ever have produced the
  expected value. The test now matches the shipped behaviour. `node --test tests/js/` is
  green.

### Fixed (harness)
- The reader-server mutation target's command mixed `unittest discover -p
  test_unit_reader_server.py` (a module that does not exist) with a positional module name,
  so it ran **nothing** while the run still reported success — the baseline gate now refuses
  it. Corrected, which exposed the honest score: **2/46 = 0.04**, not the 1.00 previously
  reported from a command that had stopped running tests.

## [1.17.9] — 2026-10-08

### Fixed
- **A failed download reported nothing at all (`qute-yt-dl`).** The generated runner glued
  its notification command together by hand (`'yt-dlp'"'"' …`) and interpolated the result
  unquoted. Unquoted expansion does not process backslashes, so the words split anyway — and
  a stray quote from that glue made the runner a **syntax error**, meaning the entire
  reporting block never ran: no "FAILED (exit N)" in the log, no failure notification. The
  notifier is now a single-quoted literal assignment called with the message as a function
  *argument*, so no escaping is involved. Verified by regenerating the runner with stub
  binaries: valid bash, success notification is exactly `yt-dlp Finished — <dir>`, and a
  failed run logs `FAILED (exit 3)` and notifies.
- **Reader state could be lost or silently dropped.** `saveState` captured its payload when
  the 900 ms debounce was *scheduled*, so a scroll during that window was never persisted
  (you resumed at the pre-scroll position). It also advanced its "last sent" marker before
  attempting the write, so a beacon that never landed counted as delivered and was never
  retried. The payload is now built at send time, and the marker advances only when
  `sendBeacon` reports the write was accepted or the fetch returns `ok`.

## [1.17.8] — 2026-10-08

### Fixed
From three read-only deep-dive audits; each finding re-verified here before fixing.

- **Publisher mislabelling (status page was confidently wrong).** `publisher_for()` matched
  a dataset entry by bare substring, and the second candidate is the domain's *first label*
  — often two letters, e.g. `rt` for `rt.com`. So "Auto Motor und Sport" was labelled
  **RT / state-controlled / low factual**, "SPEEDWEEK.com" became **Deutsche Welle**, and
  `Fortune` matched RT. Matching is now word-boundary only. Verified: those three no longer
  match, while "CNN Türk" → CNN still does.
- **Dismissing the AI summary didn't stick.** The close button removed the card and rebuilt
  the blocks but never cleared `pState.summary`, which `renderSummary` had already
  persisted — so the summary came back on the next load. The dismissal is now saved.
- **`article_marks` failed wholesale on long articles (E2BIG).** The whole article was sent
  as one command-line argument, and Linux caps a single argv string at ~128 KiB, so a long
  article scored *nothing*. Paragraphs are now batched by size, each result carries an
  explicit global index (the client trusts `item.index` over position, so a batch-local
  index could have mis-attributed scores), and results are returned in document order.

## [1.17.7] — 2026-10-08

### Added
- **The first tests for `reader/reader.js`** (`tests/js/reader.test.js`, node:test, no new
  dependencies). They pin the two bugs the audit found by hand: media spliced in reverse
  order at a shared anchor, and the in-paragraph "AI?" button passing a loop index where
  an element was required. 4 pass; 1 (a dep-injection probe) is skipped with its reason
  stated rather than left red.
- **`reader/reader.js` is now a mutation target**, so its coverage gap is measured instead
  of hidden: it scores 1/46 = 0.02. The DOM-driven behaviour (fact cards, wheel,
  persistence) needs a browser harness; this is the honest baseline for that work.
- The mutation runner's baseline gate proved itself immediately: it refused to score
  reader.js while those tests were red, instead of reporting a meaningless number.

## [1.17.6] — 2026-10-08

### Fixed
Three bugs confirmed by a read-only audit of the whole plugin, each re-verified here.

- **`,zr` ("forget this domain's zoom") did nothing but re-apply the saved zoom** — it was
  bound to `zoom-load`, the same command as `,zl`, while `zoom-reset` was defined and bound
  nowhere. Pressing it could never return the domain to 100%, despite the README.
- **The `t` binding silently killed qutebrowser's `th`/`tl`.** `t` is a strict prefix of
  both (`back -t` / `forward -t` in stock bindings), and qutebrowser executes a binding that
  has a command *before* descending into longer ones, so `th`/`tl` were unreachable. The
  binding is removed; stock `O` already opens a new tab, so nothing is lost.
- **Two media embedded after the same paragraph came out swapped.** `spliceMedia` iterated
  its items backwards while always inserting before the *same* reference element, reversing
  them. It now iterates forward — `ref` is an element, so DOM insertion cannot shift it;
  the backwards order only existed to dodge index shifts. Proved in a stub DOM: same-anchor
  media now renders `p0, m0, m1, p1`.

## [1.17.5] — 2026-10-08

### Fixed
- **The in-paragraph "AI?" button did nothing.** Its click handler called
  `markParagraph(i)` with the block *index*, but `markParagraph(el)` expects an
  *element* — it runs `blockText(el)` and returns early on empty text, so passing a
  number made the button a silent no-op. The `,m` / double-tap path passed a real
  element, which is why that route worked and this one never did. It now passes the
  element, which is also the durable handle (`idxOf()` re-resolves the index after a
  rebuild). Proved in a sandbox driving the real function: index → 0 AI calls,
  element → 1 AI call with the paragraph text.

## [1.17.4] — 2026-10-08

### Fixed
- **Focus jumping to the summary (properly this time).** `renderSummary` ended with
  `setActive(0)`, and the summary card is block 0 — so rendering it moved the reader onto
  the summary. The first two attempts keyed off the wrong thing: `factCheckArticle` and
  `renderFactCard` never rebuild blocks at all, and the card is rendered on **restore**
  (`if (pState.summary)`), where it does not yet exist in the DOM, so "the card already
  existed" fell through to `setActive(0)` — exactly the fact-check → reload case reported.
  The rule is now unconditional: a rebuild never steals focus. The active paragraph is
  held by text key (inserting the card shifts every index) and restored; the card takes
  focus only when nothing is active.

## [1.17.3] — 2026-10-08

### Fixed
- **Article fact-check now covers every paragraph.** It had a hard `max_paras=12` cap
  (the rest of the article was never checked) and asked the model to cover the whole
  article in a single prompt, so entries got dropped as well — "fact-check the article"
  checked an unpredictable subset. Every paragraph over 20 characters is now checked, in
  batches of 8 small enough that the model answers for all of them, and any paragraph
  the model still skips comes back with a stated reason instead of vanishing. Results
  are returned in document order, one per paragraph, never duplicated.

## [1.17.2] — 2026-10-08

### Fixed
- **The status page did not render.** The reader server is started on demand and then
  reused for as long as it lives, so a server started before an update kept serving the
  old routes: `/status` and `/publisher` answered 404 and the page came up empty. The
  server now stamps its own build (a hash of its source) into `server.json` and `/health`,
  and the userscript retires a server whose build does not match the file on disk —
  including one with no build at all, which is by definition running old code. A stale
  server can no longer hide a new route.
- **Fact-checking threw the reader onto the summary.** `renderSummary` ended with
  `setActive(0)`, and the summary card is block 0, so the rebuild that a fact-check
  triggers moved focus to the summary instead of leaving it on the paragraph being read.
  A rebuild now keeps the active paragraph; only an explicit summary request, where no
  card existed before, focuses the card.

## [1.17.1] — 2026-10-08

### Changed
- The article status page is bound to `,i` only. It was briefly on `,sts`, which is
  unusable: `,s` (article summary) is bound, and a binding that is a prefix of another
  makes qutebrowser wait out the keyhint timeout before firing the shorter one — so
  `,sts` was dead *and* it made `,s` feel laggy. One conflict-free key, no downside.

## [1.17.0] — 2026-10-08

### Added
- **Article status page** — press `,sts` (or `,i`) and a local page opens for the
  article you are on:
  * **Citation block** — title, author(s), publisher, publication date, site, language,
    canonical URL and access date, taken from the page's own JSON-LD and meta tags
    (never guessed: a field the page does not state stays empty), plus APA, MLA,
    Chicago and BibTeX with a copy button each.
  * **Article metrics**, computed locally — words, reading time, paragraphs, sentences,
    quoted passages and quote density, numbers/statistics, attributed vs vague
    sourcing, outbound links, images, headline length, and framing cues (loaded words in
    the headline and opening paragraphs) — drawn as a grouped bar chart and explained
    in words underneath.
  * **Publisher profile** — a marker on a left/centre/right spectrum (with how many of
    the other outlets covering the story sit in each band), a low/mixed/high
    factual-reporting gauge, the funding mix as a legend-ed bar, and the ownership
    chain (publisher -> owner -> parent group), plus an encyclopaedia summary and the
    links to verify it all.
  * **Cross-outlet coverage** — a news search on the story's keywords lists other
    outlets' headlines, each tagged with its own lean, and a bar showing the
    left/centre/right spread. Outlets outside the dataset are left grey rather than
    guessed.
  * **Framing analysis** on demand: the local model reports the tone, the main claim,
    the loaded terms and what the piece leaves out.

### Notes
- The bundled `data/publishers.json` (44 outlets, German and international) carries
  owner, parent group, funding model and a source per entry. Ownership and funding are
  documented facts; the lean and factual ratings are a **curated** dataset in the style
  of public media-bias charts — the page says so, and does not present them as a
  measurement. Unrated outlets stay unrated.
- `,i` runs the same command: `,s` (reader summary) is a prefix of `,sts`, so
  qutebrowser must wait for the keyhint timeout before firing `,s`.

Verified ad hoc (40 checks) against local fixtures for the news search, the
encyclopaedia and the model, so the test exercises this code and not today's internet:
token/id guards, publisher + coverage tagging (including the article's own outlet being
excluded and unknown outlets staying unknown), the citation extractor on JSON-LD and
meta tags, and the rendered page (citation formats, metric bars, spectrum, gauge,
funding legend, ownership chain, coverage list with leans, framing). A screenshot pass
confirmed every diagram is legible and nothing overlaps.

## [1.16.0] — 2026-10-08

### Added
- **Reader: embedded media.** Audio, video and embeds (YouTube/Vimeo/…) are kept from
  the original page and put back next to the paragraph they followed — with absolute
  URLs, because the reader is served from a loopback port where a relative URL would
  resolve against the wrong host. Captions survive, players keep `controls`, embeds
  get a 16:9 frame plus an "open" link, ad frames (doubleclick/googlesyndication/…)
  and 1x1 tracking pixels are dropped, and media is never counted as an AI text
  block. Whatever Readability kept is stripped first, so nothing appears twice.
- **Choosing between accounts on one domain** (`qute-keepassxc-fill`): `,pw` fills the
  remembered account and each further press advances to the next match for that
  domain, with the status bar saying which — "account 2/3 — press again for the next,
  `,ka` to pick". `,ka` opens a picker whose entries read `group · title — login`, and
  `--account N|LOGIN|UUID|TITLE` selects one directly (both are remembered);
  `--forget` clears it. The memory is per domain in
  `$XDG_STATE_HOME/omarchy-qutebrowser/keepassxc/accounts.json` (0600).
- **Cookies are gone when the browser closes:** `content.cookies.store = False`, so
  they live in memory for the session and nothing is written to `cookies.sqlite`.

### Changed
- **Cookie consent procedure** (`cookie-banner-remover.js`): the sweep now also looks
  inside open shadow roots and same-origin iframes, where newer consent managers
  render their banner; buttons are pressed with the full pointer sequence instead of
  a bare `.click()` (frameworks that only listen for `pointerdown` ignored it); each
  banner is decided on once; and the result is verified — a banner that survives its
  own click is pressed again and then removed.

Verified ad hoc (40 checks): a real browser session that receives a cookie writes no
cookies.sqlite; consent handled inside a shadow root, inside a same-origin iframe, on
a pointerdown-only button, and escalated when the banner survives its click; account
labels/matching/rotation/remembering/--forget plus the 0600 per-domain file; and the
reader keeping video/audio/embed with absolute URLs, captions and correct placement
while dropping ad frames and tracking pixels.

## [1.15.0] — 2026-10-08

### Fixed
- **Password fill now advances two-step logins.** The fill only ever typed into
  fields, so on Microsoft the password page — which does not exist until "Next" is
  pressed — was never reached and the fill looked like it did nothing. It now
  presses the login action: `identifierNext`/`passwordNext` (Google), `idSIButton9`
  (Microsoft), the form's submit button, or a button labelled
  Next/Weiter/Continue/Sign in/Anmelden. The press sends the full pointer sequence
  (a bare `.click()` is ignored by div-based buttons) and retries once if the control
  is still `aria-disabled`. It only advances on a real login step — a single
  identifier field, or a filled password with a login-shaped button — and never on a
  sign-up/registration/checkout form. `--fill-only` turns advancing off.
- **Google's "This browser or app may not be secure" is fixed.** qutebrowser ships a
  site-specific quirk (`ua-google`) that sends a *Firefox* UA to accounts.google.com;
  on a Chromium engine that is an inconsistent fingerprint, and Google answers it by
  refusing the sign-in. That quirk is now skipped and a real Chrome UA is sent (real
  Chromium version, no QtWebEngine token) — for Google and Microsoft alike.
- Fill robustness: `div[role=button]` Next buttons are no longer skipped (the
  visibility check rejected anything with `tabIndex === -1`, which every div has),
  fields inside open shadow roots are found, decoy fields (`name="hiddenPassword"`)
  are never filled, and a page whose fields report no layout still gets filled.

Verified ad hoc (30 checks) in a real engine driving the actual fill template: Google
identifier step (email filled, decoy untouched, Next pressed), Google password step,
both Microsoft steps (filled, idSIButton9 clicked, form submitted), a registration
form filled but NOT submitted, `--fill-only` pressing nothing, a React-style tracked
input still reporting the filled value, and the one-line FIFO rendering keeping the
regexes intact — plus a sandbox run confirming Chrome (not Firefox) goes to
accounts.google.com.

## [1.14.0] — 2026-10-08

### Added
- **SponsorBlock.** The YouTube userscript now fetches segment data from the public
  SponsorBlock API for whatever video is playing and skips it locally: sponsor,
  self-promo, interaction reminder, intro, outro, preview and non-music sections.
  `mute` segments are muted rather than seeked past, and a `full` segment (the whole
  video is the sponsor) only raises a toast — the tab is never navigated away.
  `filler` and `poi` are deliberately not skipped. Inspect or toggle it from the
  page console: `window.omarchySponsor.toggle()`, `.segments()`, `.current()`.
- **Sponsor segments are cut out of downloads too:** `,dv`/`,dm` pass yt-dlp
  `--sponsorblock-remove` with the same category list (override with
  `SPONSORBLOCK_CATEGORIES=...`, set it empty to keep the segments).
- **Twitch shortcut:** `,t` opens twitch.tv, matching `,y` for YouTube. Both now go
  through `youtube`/`twitch` aliases, so the keyhint popup reads well.

Verified ad hoc (25 checks): the real functions extracted from the userscript under
node — video id from watch/shorts URLs, segment lookup with the boundary guard, seek
past a sponsor segment, mute a mute segment, unmute afterwards, no-op when toggled
off — plus the config/binding/alias wiring, yt-dlp receiving the category list, and
the live SponsorBlock API answering in the shape the code parses.

## [1.13.1] — 2026-10-08

### Fixed
- Ad fields are now stripped from player / `ytInitialData` payloads at **any depth**.
  `stripAds` previously only cleaned the top level plus three hand-picked paths
  (`playerResponse`, `streamingData`, `playerOverlays`), so an ad field nested
  anywhere else survived. A bounded deep sweep (`walkAds`) replaced those special
  cases — found by the ad-hoc verification, which now asserts a nested `adSlots`
  is removed as well.

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

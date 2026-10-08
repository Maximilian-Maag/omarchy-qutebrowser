# omarchy-qutebrowser

[Qutebrowser](https://qutebrowser.org/) configured for [Omarchy](https://omarchy.org/) — keyboard-driven, fully themed, privacy-first, and ad-free.

## Features

| Feature | Details |
|---------|---------|
| **22 Omarchy themes** | Every stock theme (catppuccin, nord, tokyo-night, gruvbox, …) plus automatic live switching when you run `omarchy theme set` |
| **KeePassXC** | Fill passwords with `Alt+Shift+U` (insert) or `pw` (normal) via the bundled `qute-keepassxc` userscript (`--insecure` mode, no GPG required) |
| **YouTube ad-free** | Removes pre-roll/mid-roll video ads by stripping the ad payload out of the player response before YouTube reads it, plus ad-request blocking and skip/force-end fallbacks |
| **Built-in ad blocker** | Brave + EasyList + EasyPrivacy + uBlock Origin filter lists, host-based blocking |
| **yt-dlp download** | `,dv` downloads a video (best mp4), `,dm` extracts MP3. On a video page it grabs that video; on any list (YouTube search results, a channel, …) it shows hints so you pick which video — works on YouTube, Vimeo, and 1000+ other sites |
| **Default browser** | `install.sh` sets qutebrowser at all three levels: user `~/.config/mimeapps.list`, system `/etc/xdg/mimeapps.list`, and Omarchy `/usr/share/applications/mimeapps.list` |

## Installation

### Via `omarchy plugin add` (recommended)

```bash
omarchy plugin add https://github.com/Maximilian-Maag/omarchy-qutebrowser --yes
```

Then run the install script once to wire up symlinks and set the default browser:

```bash
bash ~/.config/omarchy/plugins/Maximilian-Maag.qutebrowser/install.sh
```

### Manual

```bash
git clone https://github.com/Maximilian-Maag/omarchy-qutebrowser \
    ~/.config/omarchy/plugins/Maximilian-Maag.qutebrowser
bash ~/.config/omarchy/plugins/Maximilian-Maag.qutebrowser/install.sh
```

The install script:
- Symlinks `config.py`, `themes.py` and `site-overrides.py` into `~/.config/qutebrowser/`
- Symlinks the YouTube + cookie-banner Greasemonkey scripts into `~/.local/share/qutebrowser/greasemonkey/`
- Installs the `theme-set` hook into `~/.config/omarchy/hooks/theme-set.d/`
- Sets qutebrowser as the default browser via `xdg-settings`
- Installs `python-pynacl` via pacman (required by `qute-keepassxc`)

## Themes

Themes switch automatically when you change the Omarchy theme:

```bash
omarchy theme set nord
# → qutebrowser reloads and picks up the nord palette immediately
```

All 22 stock themes are supported:

catppuccin · catppuccin-latte · ethereal · everforest · flexoki-light ·
gruvbox · hackerman · kanagawa · last-horizon · lumon · lupine · matte-black ·
miasma · nord · osaka-jade · retro-82 · ristretto · rose-pine · solitude ·
tokyo-night · vantablack · white

Custom user themes under `~/.config/omarchy/themes/<name>/` are loaded
automatically from their `colors.toml`. The plugin also bundles an extra
`aether` palette (23 palettes total) for when no stock theme matches.

## KeePassXC

1. Enable **Browser Integration** in KeePassXC (`Tools → Settings → Browser Integration`)
2. Open qutebrowser and navigate to a login page
3. Press `Alt+Shift+U` (insert mode) or type `pw` (normal mode)
4. KeePassXC will ask you to confirm the connection on first use

Password fill uses our own `qute-keepassxc-fill` userscript (MIT), which speaks
the KeePassXC-Browser socket protocol and reuses the association qutebrowser's
bundled `qute-keepassxc` already stored. It fills far more reliably than the
bundled script on modern sign-in pages:

- **Multi-step logins** (Google, Microsoft): fills the username/email field even
  on a page with no password field, so `pw` → *Next* → `pw` works
- **No hidden-field writes**: never fills an invisible/`aria-hidden` decoy
  password field (Google's identifier page ships one, `name="hiddenPassword"`)
- **Visible fields only**, and values are set via the native setter with
  `input`/`change`/`keyup`/`blur` events so React/Vue/Angular register them
- **TOTP**: press `pt` with the code field focused
- **Multiple accounts**: picked with `gum`/`fzf` in a floating terminal when
  `rofi` is not installed

Requires `python-pynacl` (`omarchy pkg add python-pynacl`) — the install script handles this automatically.

## Password fill on two-step logins

`,pw` (and `<Alt+Shift+u>`) fill the password-manager match for the page and then
**press the login action**, because Microsoft's and Google's sign-in pages do not
have a password field at all until "Next" is pressed:

- Pressed: `identifierNext` / `passwordNext` (Google), `idSIButton9` (Microsoft),
  the form's submit button, else a button labelled Next / Weiter / Continue /
  Sign in / Anmelden.
- Only on a real login step: a single identifier field, or a filled password with a
  login-shaped button. A sign-up, registration or checkout form is filled but never
  submitted.
- `qute-keepassxc-fill --fill-only` fills without pressing anything.

Google's "This browser or app may not be secure" is handled too: qutebrowser's
built-in `ua-google` quirk sends a *Firefox* UA to accounts.google.com, which is an
inconsistent fingerprint on a Chromium engine. That quirk is skipped and a real
Chrome UA is sent (the real Chromium version, no QtWebEngine token), for Google and
Microsoft sign-in hosts only.

### Several accounts on one domain

When more than one entry matches a site (personal + work, two shops, …):

| How | What happens |
|-----|--------------|
| `,pw` (or `<Alt+Shift+u>`) | Fills the remembered account; **each further press advances** to the next match, and the status bar says which: `KeePassXC: account 2/3 — press again for the next, ,ka to pick` |
| `,ka` | Opens a picker (gum, floating terminal). Entries read `group · title — login`, so two accounts on one site are told apart by their group and title, not just the username |
| `--account 2` / `--account me@corp.example` / `--account bbbb` / `--account Shop` | Picks match #2, by login, by uuid prefix, or by a title substring — and remembers it |
| `--forget` | Forgets the remembered account for this domain |

The choice is remembered per domain in
`$XDG_STATE_HOME/omarchy-qutebrowser/keepassxc/accounts.json` (0600). An explicit choice (`--account` or the picker) is used again next time; a plain
`,pw` rotates, which is what makes pressing the key twice switch accounts.

## Cookies and storage

`content.cookies.store = False`: cookies live in memory for the session only, so
quitting the browser clears every one of them and nothing is written to
`cookies.sqlite`. Site logins therefore do not survive a restart by design — the
password manager fills them again on demand. HTML5 local storage is unaffected; set
`content.local_storage = False` too if you want *everything* wiped at exit.

Cookies are also rejected out of the box (`content.cookies.accept = "no-3rdparty"`),
and consent banners are dismissed automatically with a reject-first policy (see
`userscripts/cookie-banner-remover.js`): reject is always preferred, accept only when
the banner offers no reject option, a banner with no buttons at all is removed, and
the sweep reaches inside shadow roots and same-origin iframes.

## Reader: embedded media

Articles with audio, video or embeds keep their players in the reader: the media is
collected from the original page with **absolute URLs** (the reader runs on a loopback
port), placed back next to the paragraph it followed, keeps its caption and controls,
and embeds get a 16:9 frame plus an "open" link. Ad frames and 1x1 tracking pixels are
dropped, and players are not treated as article text, so the AI never scores them.

## Article status page

`,i` opens a status page for the article you are on — the kind of overview
Ground News gives every story, built from the page itself plus one news search:

- **Cite this article** — every field a citation needs (author, publisher, date,
  canonical URL, access date), read from the page's JSON-LD and meta tags and left
  empty rather than guessed when the page does not state it, in APA, MLA, Chicago and
  BibTeX with copy buttons.
- **What is in this article** — length, reading time, quotes and quote density,
  statistics, attributed vs vague sourcing, links, images, headline length and framing
  cues, as a grouped bar chart.
- **Publisher** — lean marker on a left/centre/right spectrum (plus where the other
  outlets covering the story sit), a factual-reporting gauge, the funding mix, and the
  ownership chain up to the parent group, with sources.
- **Who else ran this story** — other outlets' headlines tagged with their lean, and
  the left/centre/right spread.
- **How it is framed** — on demand, the local model on the tone, the claim, the loaded
  terms and the omissions.

Ownership and funding are documented facts with a source each. The lean and
factual-reporting ratings come from the bundled curated dataset
(`data/publishers.json`, 44 outlets) in the style of public media-bias charts: they are
a signpost, not a measurement, and the page says so. Outlets that are not in the
dataset are shown unrated — never guessed.

## Ad-free YouTube

Two layers, so an ad is normally never scheduled in the first place:

**In the page** — a Greasemonkey content script runs on every `*.youtube.com` page:

- **Strips the ad parameters out of the outgoing player request** (`adParams`,
  `adBreakParams`, `adSlots`, `adPlacements`, `adSignalsInfo`, …) before it leaves
  the browser. YouTube builds its ad schedule from those, so with them gone there is
  no pre-roll or mid-roll ad to play at all — not merely one that gets skipped.
- Removes the same fields from player/`ytInitialData` responses as a second line.
- Drops requests to the ad endpoints, and removes ad DOM elements (banners,
  overlays, sidebar ads, the "ad blocker detected" wall).
- Still skips/force-ends any ad that does manage to play, and restores your own
  playback speed afterwards.

**At the network layer** — `config/blocking/youtube-ads.txt` (15 rules for the
YouTube ad endpoints plus DoubleClick/AdSense/GTM) is the first entry in
`content.blocking.adblock.lists`, alongside EasyList and the uBO lists. It is
versioned with the plugin, so YouTube ad blocking does not depend on an upstream
list being current. `googlevideo.com` is deliberately left alone — that is the
video CDN itself.

After a plugin update run `:config-source`, then `,ab` (`:adblock-update`) once:
qutebrowser caches parsed filter lists, so a newly added list only takes effect
after that refresh.

## SponsorBlock

Segment data comes from the public [SponsorBlock](https://sponsor.ajay.app/) API for
the video that is playing, and is skipped locally by seeking past it:

- Skipped: `sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `preview`,
  `music_offtopic`.
- Not skipped: `filler` (removes tangents plenty of people want) and `poi` (marks
  highlights, not skip-bait).
- `mute` segments are muted instead of seeked past; a `full` segment (the whole
  video is the sponsor) only shows a toast — the tab is never navigated away.
- Every skip shows a brief toast naming the category and its length.

Downloads get the same treatment: `,dv` / `,dm` pass yt-dlp `--sponsorblock-remove`
with those categories, so downloaded files have the segments cut out.
Override with `SPONSORBLOCK_CATEGORIES=sponsor,selfpromo` (or `""` to keep them).

Toggle it from the page console (`window.omarchySponsor.toggle()`) or bind your own
key to it if you want one.

## Quick shortcuts

| Key | Action |
|-----|--------|
| `,y` | Open YouTube |
| `,t` | Open Twitch |

## Key bindings

| Key | Mode | Action |
|-----|------|--------|
| `Alt+Shift+U` | insert | Fill password from KeePassXC |
| `pw` | normal | Fill password from KeePassXC |
| `pt` | normal | Fill TOTP code into the focused field |
| `t` | normal | Open new tab |
| `X` | normal | Close tab |
| `F` | normal | Open link in new tab (hint mode) |
| `,ab` | normal | Update ad block filter lists |
| `,dt` | normal | Toggle dark mode on the current page |
| `,y` | normal | Open YouTube |
| `,dv` | normal | Download a video (yt-dlp). On a video page → that video; on any list → hints to pick |
| `,dm` | normal | Download as MP3 (yt-dlp + ffmpeg). Same picking behaviour |
| `,af` | normal | AI site fix — analyze page and save per-domain fixes |
| `,r` | normal | Open the current page in reader mode |
| `,n` / `,N` | normal | Reader: next / previous paragraph |
| `,f` | normal | Reader: toggle paragraph focus |
| `,m` / `,M` | normal | Reader: mark current paragraph / whole article as AI |
| `,s` | normal | Reader: AI summary of the article |
| `,S` | normal | Reader: AI summary of the current paragraph (also `Ctrl+↑`) |
| `,e` | normal | Reader: AI score the current paragraph (also `◀` / `←`) |
| `,c` | normal | Reader: fact-check the current paragraph against other outlets (also `▶` / `→`; again = focus the wheel, double = whole article) |
| `,o` | normal | Reader: open the focused supporting-article preview (also `Enter`) |
| `,O` | normal | Reader: fact-check the whole article |
| `,z+` / `,z-` | normal | Zoom in / out (remembered per domain) |
| `,zl` / `gd` | normal | Apply the saved zoom for this domain |
| `,zr` | normal | Forget this domain's zoom (back to 100%) |
| `,p` | normal | Open current URL in a private window |
| `,kp` | normal | Check KeePassXC setup status |

## AI site fixes

`,af` sends the current page to an LLM (`hermes`), which returns CSS hides,
CSS overrides and cosmetic filter selectors for that domain. Fixes are saved to
`~/.local/state/omarchy-qutebrowser/site-fixes/<domain>.json` and applied on the
next load through a **generated per-domain Greasemonkey script**
(`greasemonkey/omarchy-sitefix-<domain>.js`). Because each script is `@match`'d
to its own domain, a fix for one site can never leak onto another.

> qutebrowser's `content.user_stylesheets` is global (no per-domain patterns),
> which is why fixes go through Greasemonkey instead of a shared stylesheet.

## Reader mode

`,r` extracts the article (Mozilla Readability) and opens it in a clean,
distraction-free page served locally — no ads, no sidebars, no chrome:

- **Paragraph-wise reading** — the current paragraph is highlighted (focus mode)
  and the rest dimmed. Move with the `↑`/`↓` toolbar buttons or the `,n` / `,N`
  keys; `,f` toggles focus; clicking a paragraph jumps to it.
- **AI score for one paragraph** — the `◀ AI score` button, the `←` key or `,e`
  asks the local model whether that paragraph looks AI-written (human / mixed /
  AI + likelihood), shown as a coloured left border and a score chip.
  **Double `←`** removes the AI-written paragraphs (an *Undo* button restores them).
- **Fact-check a paragraph** — the `Fact-check ▶` button, the `→` key or `,c`
  searches Google News (de + en) for the paragraph's key terms and asks the local
  model whether other news outlets corroborate or contradict it. The **verdict
  card appears to the LEFT of the paragraph** and a **wheel of supporting articles
  to the RIGHT**: press `→` again to focus the wheel, scroll the previews with
  `↑`/`↓` (or `,n`/`,N`, or the mouse wheel) and press **Enter** (or `,o`, or the
  *Open ↵* button) to open the focused article in a new tab. Press **`←`** to leave
  the wheel and return to the paragraph.
  **Double `→`** fact-checks the whole article in one pass.
- **Mark the whole article** — the *Mark AI text* button (`,M`) scores every
  paragraph in one pass.
- **AI summary** — the *Summarize* button (`,s`) adds a summary block *above the
  title* which takes part in paragraph focus, so `↑` from the headline reaches it.
  Pressing **`↑` on the first paragraph summarises the whole article**, and
  **`Ctrl+↑` summarises just the current paragraph** (one sentence; `,S` does the
  same).
- **Advertorial warning** — the same summary call also judges whether the piece
  reads as *paid or promotional content* (advertorial, sponsored/native ad, PR,
  affiliate). When it does, a warning sits at the top of the summary block — "⚠
  Probably paid or promotional content" (red) or "⚠ Some commercial-marketing
  signals" (amber) — naming the kind, a confidence score, and the concrete signal
  it was read from (an `ANZEIGE`/`sponsored` label, a `jetzt kaufen` call to
  action, unopposed brand praise…). Ordinary reporting is not flagged (a neutral
  article scores ~5, an undisclosed advertorial ~95).
- **Side layout** — the fact-check card and the article wheel sit in side padding
  the article *reserves* for them, so they never overflow or cover the text,
  full-screen or not; under ~1180px wide they simply flow under the paragraph.
- **Text size** — `A−` / `A+` in the toolbar.

The per-paragraph `AI?` button and score chip sit in a reserved gutter beside the
text, never on top of it.

Everything runs against the **local** agent (`hermes -z … --cli`) via a small
loopback HTTP server (`bin/reader-server`, started on demand, bound to 127.0.0.1
and gated by a per-session token). No text leaves the machine. Colours follow the
active Omarchy theme.

Note: qutebrowser swallows page key events in normal mode, so the reader page's
own `j`/`k`/`m`/`s` shortcuts only fire in insert mode — use the `,n` `,N` `,f`
`,m` `,M` `,s` keybindings (they drive the reader from normal mode and no-op on
other pages) or the toolbar buttons. Pressing `,r` on a reader page is refused so
you can't nest reader-inside-reader.

## Search engines

| Prefix | Engine |
|--------|--------|
| (default) | Brave Search |
| `g` | Google |
| `yt` | YouTube |
| `gh` | GitHub |
| `arch` | Arch Linux packages |
| `aur` | AUR |
| `mdn` | MDN Web Docs |
| `wp` | Wikipedia |

## Structure

```
omarchy-qutebrowser/
├── config/
│   ├── config.py           — main qutebrowser config (symlinked to ~/.config/qutebrowser/)
│   ├── themes.py           — palette engine for all 22 stock themes (+ aether)
│   └── site-overrides.py   — turns qute-ai-fix JSON into per-domain Greasemonkey scripts
├── hooks/
│   └── theme-set           — omarchy hook: reloads qutebrowser on theme change
├── userscripts/
│   ├── qute-keepassxc-setup — KeePassXC setup check (,kp)
│   ├── qute-keepassxc-fill  — robust KeePassXC password/TOTP fill (pw / Alt+Shift+U / pt)
│   ├── qute-yt-dl           — yt-dlp download (,dv / ,dm)
│   ├── qute-zoom            — per-domain zoom persistence (,z / ,zl / ,zr)
│   ├── qute-ai-fix          — AI per-site fix engine (,af)
│   ├── qute-reader          — reader mode: ingest page + open the reader tab (,r)
│   ├── youtube-adblock.js   — Greasemonkey ad-blocking for YouTube
│   └── cookie-banner-remover.js — Greasemonkey cookie-consent remover
├── reader/
│   ├── index.html           — reader page template
│   ├── reader.css           — distraction-free styling (theme-aware)
│   ├── reader.js            — extraction, focus, AI marks, summary
│   └── readability.js       — Mozilla Readability (Apache-2.0)
├── bin/
│   ├── reader-server        — loopback bridge: serves reader page + POST /ai (local agent)
│   └── set-system-default   — privileged: sets qutebrowser as system default browser
├── install.sh               — one-shot installer
└── manifest.json            — Omarchy plugin manifest
```

## License

MIT

<!-- policy-as-code -->

## Policy as code

Policies that only live in prose drift. This repository enforces its own in
`tools/policy_check.py` (dependency-free), configured by `policy.json`:

    python3 tools/policy_check.py            # every tracked file
    python3 tools/policy_check.py --changed  # only what you changed (pre-commit)
    python3 tools/policy_check.py --ci       # changed vs the base branch (CI)

`--changed` is wired into `.githooks/pre-commit` and the checks also run in
`.github/workflows/policy.yml`, so a violation fails the commit or the pull
request. After cloning, enable the hook once:

    git config core.hooksPath .githooks

Documented exceptions belong in `policy.json` under `allow`, each with a reason —
an exception you can read is a decision; a check nobody runs is decoration.

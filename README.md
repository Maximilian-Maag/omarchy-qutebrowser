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

## Ad-free YouTube

A Greasemonkey content script runs on every `*.youtube.com` page and:

- Immediately skips any skippable pre-roll ad
- Jumps non-skippable ads to their end (150ms latency max)
- Removes ad DOM elements (banners, overlays, sidebar ads)
- Intercepts `fetch`/`XHR` calls to Google ad network endpoints

Combined with the built-in host-based ad blocker, most ads never load at all.

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
| `,s` | normal | Reader: AI summary |
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
  *Open ↵* button) to open the focused article in a new tab.
  **Double `→`** fact-checks the whole article in one pass.
- **Mark the whole article** — the *Mark AI text* button (`,M`) scores every
  paragraph in one pass.
- **AI summary** — the *Summarize* button (`,s`) adds a summary block *above the
  title* which takes part in paragraph focus, so `↑` from the headline reaches it.
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

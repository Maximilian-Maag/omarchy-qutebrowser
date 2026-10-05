# omarchy-qutebrowser

[Qutebrowser](https://qutebrowser.org/) configured for [Omarchy](https://omarchy.org/) — keyboard-driven, fully themed, privacy-first, and ad-free.

## Features

| Feature | Details |
|---------|---------|
| **22 Omarchy themes** | Every stock theme (catppuccin, nord, tokyo-night, gruvbox, …) plus automatic live switching when you run `omarchy theme set` |
| **KeePassXC** | Fill passwords with `Alt+Shift+U` (insert) or `pw` (normal) via the bundled `qute-keepassxc` userscript |
| **Ad-free YouTube** | Greasemonkey script skips pre-roll ads, removes overlays, and intercepts ad network requests |
| **Built-in ad blocker** | Brave + EasyList + EasyPrivacy + uBlock Origin filter lists, host-based blocking |
| **Default browser** | `install.sh` registers qutebrowser as the system default via `xdg-settings` |

## Installation

```bash
# 1. Install qutebrowser and keepassxc if not already present
omarchy pkg add qutebrowser keepassxc

# 2. Clone the plugin
git clone https://github.com/Maximilian-Maag/omarchy-qutebrowser \
    ~/.config/omarchy/plugins/Maximilian-Maag.qutebrowser

# 3. Run the install script
bash ~/.config/omarchy/plugins/Maximilian-Maag.qutebrowser/install.sh
```

The install script:
- Symlinks `config.py` and `themes.py` into `~/.config/qutebrowser/`
- Symlinks the YouTube Greasemonkey script into `~/.local/share/qutebrowser/greasemonkey/`
- Installs the `theme-set` hook into `~/.config/omarchy/hooks/theme-set.d/`
- Sets qutebrowser as the default browser via `xdg-settings`
- Checks for `pynacl` (required by `qute-keepassxc`)

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
automatically from their `colors.toml`.

## KeePassXC

1. Enable **Browser Integration** in KeePassXC (`Tools → Settings → Browser Integration`)
2. Open qutebrowser and navigate to a login page
3. Press `Alt+Shift+U` (insert mode) or type `pw` (normal mode)
4. KeePassXC will ask you to confirm the connection on first use

Requires `pynacl` (`pip install pynacl`) — the install script handles this automatically.

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
| `t` | normal | Open new tab |
| `X` | normal | Close tab |
| `F` | normal | Open link in new tab (hint mode) |
| `,ab` | normal | Update ad block filter lists |
| `,d` | normal | Toggle dark mode on current page |
| `,y` | normal | Open YouTube |

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
│   ├── config.py       — main qutebrowser config (symlinked to ~/.config/qutebrowser/)
│   └── themes.py       — palette engine for all 22 Omarchy themes
├── hooks/
│   └── theme-set       — omarchy hook: reloads qutebrowser on theme change
├── userscripts/
│   └── youtube-adblock.js  — Greasemonkey ad-blocking script for YouTube
├── install.sh          — one-shot installer
└── manifest.json       — Omarchy plugin manifest
```

## License

MIT

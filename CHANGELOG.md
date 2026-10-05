# Changelog

All notable changes to omarchy-qutebrowser are documented here.

## [Unreleased]

### Added
- `qute-yt-dl` userscript: download current page as video (`,dv`) or MP3 (`,dm`) via yt-dlp, with live progress in a floating terminal
- `qute-keepassxc-setup` userscript: first-run guide that checks KeePassXC install, running state, and Browser Integration socket (`,kp`)
- `qute-zoom` userscript: per-domain zoom persistence — save (`,z`), restore (`,zl`), reset (`,zr`)
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

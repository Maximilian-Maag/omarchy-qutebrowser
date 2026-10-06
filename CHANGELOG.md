# Changelog

All notable changes to omarchy-qutebrowser are documented here.

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

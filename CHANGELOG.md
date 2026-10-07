# Changelog

All notable changes to omarchy-qutebrowser are documented here.

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

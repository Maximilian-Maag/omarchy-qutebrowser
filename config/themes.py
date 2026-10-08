"""
omarchy-qutebrowser: theme engine
Applies a qutebrowser color palette derived from the active Omarchy theme.

Usage (from config.py):
    from themes import apply_theme
    apply_theme(c)

The active theme is read from $OMARCHY_THEME (set by omarchy theme set).
Falls back to catppuccin.
"""

import os

# All 22 stock Omarchy themes, keyed by their directory name.
# Each entry maps the Omarchy colors.toml palette onto qutebrowser's
# color groups: backgrounds, foregrounds, accent, error, warning, selection.
THEMES = {
    "catppuccin": {
        "mode": "dark",
        "bg":        "#1e1e2e",
        "bg_dark":   "#161622",
        "bg_darker": "#101019",
        "bg_light":  "#313244",
        "fg":        "#cdd6f4",
        "fg_dim":    "#6c7086",
        "fg_light":  "#bac2de",
        "accent":    "#89b4fa",
        "selection": "#45475a",
        "red":       "#f38ba8",
        "green":     "#a6e3a1",
        "yellow":    "#f9e2af",
        "cyan":      "#94e2d5",
    },
    "catppuccin-latte": {
        "mode": "light",
        "bg":        "#eff1f5",
        "bg_dark":   "#e3e4e8",
        "bg_darker": "#d7d8dc",
        "bg_light":  "#dce0e8",
        "fg":        "#4c4f69",
        "fg_dim":    "#9ca0b0",
        "fg_light":  "#5c5f77",
        "accent":    "#1e66f5",
        "selection": "#ccd0da",
        "red":       "#d20f39",
        "green":     "#40a02b",
        "yellow":    "#df8e1d",
        "cyan":      "#179299",
    },
    "ethereal": {
        "mode": "dark",
        "bg":        "#060B1E",
        "bg_dark":   "#040816",
        "bg_darker": "#030610",
        "bg_light":  "#131a3a",
        "fg":        "#ffcead",
        "fg_dim":    "#6d7db6",
        "fg_light":  "#c9b8a6",
        "accent":    "#7d82d9",
        "selection": "#252e56",
        "red":       "#ED5B5A",
        "green":     "#92a593",
        "yellow":    "#E9BB4F",
        "cyan":      "#a3bfd1",
    },
    "everforest": {
        "mode": "dark",
        "bg":        "#2d353b",
        "bg_dark":   "#21272c",
        "bg_darker": "#181d20",
        "bg_light":  "#343f44",
        "fg":        "#d3c6aa",
        "fg_dim":    "#4f585e",
        "fg_light":  "#9da9a0",
        "accent":    "#7fbbb3",
        "selection": "#3d484d",
        "red":       "#e67e80",
        "green":     "#a7c080",
        "yellow":    "#dbbc7f",
        "cyan":      "#83c092",
    },
    "flexoki-light": {
        "mode": "light",
        "bg":        "#FFFCF0",
        "bg_dark":   "#F2F0E5",
        "bg_darker": "#E6E4D9",
        "bg_light":  "#DAD8CE",
        "fg":        "#100F0F",
        "fg_dim":    "#B7B5AC",
        "fg_light":  "#403E3C",
        "accent":    "#205EA6",
        "selection": "#DAD8CE",
        "red":       "#AF3029",
        "green":     "#66800B",
        "yellow":    "#AD8301",
        "cyan":      "#24837B",
    },
    "gruvbox": {
        "mode": "dark",
        "bg":        "#282828",
        "bg_dark":   "#1d2021",
        "bg_darker": "#181818",
        "bg_light":  "#3c3836",
        "fg":        "#d4be98",
        "fg_dim":    "#7c6f64",
        "fg_light":  "#bdae93",
        "accent":    "#7daea3",
        "selection": "#45403d",
        "red":       "#ea6962",
        "green":     "#a9b665",
        "yellow":    "#e78a4e",
        "cyan":      "#89b482",
    },
    "hackerman": {
        "mode": "dark",
        "bg":        "#0B0C16",
        "bg_dark":   "#080910",
        "bg_darker": "#05060b",
        "bg_light":  "#12162a",
        "fg":        "#ddf7ff",
        "fg_dim":    "#3d6e7a",
        "fg_light":  "#a0d8e8",
        "accent":    "#82FB9C",
        "selection": "#0d2a1a",
        "red":       "#ff5555",
        "green":     "#82FB9C",
        "yellow":    "#f1fa8c",
        "cyan":      "#8be9fd",
    },
    "kanagawa": {
        "mode": "dark",
        "bg":        "#1f1f28",
        "bg_dark":   "#16161d",
        "bg_darker": "#0d0c0c",
        "bg_light":  "#2a2a37",
        "fg":        "#dcd7ba",
        "fg_dim":    "#727169",
        "fg_light":  "#c8c093",
        "accent":    "#7e9cd8",
        "selection": "#2d4f67",
        "red":       "#c34043",
        "green":     "#76946a",
        "yellow":    "#c0a36e",
        "cyan":      "#6a9589",
    },
    "last-horizon": {
        "mode": "dark",
        "bg":        "#0c0b0c",
        "bg_dark":   "#080708",
        "bg_darker": "#040404",
        "bg_light":  "#1a1619",
        "fg":        "#FAFCFB",
        "fg_dim":    "#5c5460",
        "fg_light":  "#c4c8c7",
        "accent":    "#b59790",
        "selection": "#2a1f1e",
        "red":       "#e06c75",
        "green":     "#89d4a0",
        "yellow":    "#e5c07b",
        "cyan":      "#56b6c2",
    },
    "lumon": {
        "mode": "dark",
        "bg":        "#16242d",
        "bg_dark":   "#101c23",
        "bg_darker": "#0b1318",
        "bg_light":  "#1f3040",
        "fg":        "#d6e2ee",
        "fg_dim":    "#4a6880",
        "fg_light":  "#8aaec8",
        "accent":    "#8bc9eb",
        "selection": "#1e3a4a",
        "red":       "#e07090",
        "green":     "#68d0b0",
        "yellow":    "#d4b870",
        "cyan":      "#8bc9eb",
    },
    "lupine": {
        "mode": "light",
        "bg":        "#fafafa",
        "bg_dark":   "#f0f0f0",
        "bg_darker": "#e4e4e4",
        "bg_light":  "#e8e8e8",
        "fg":        "#212121",
        "fg_dim":    "#9e9e9e",
        "fg_light":  "#555555",
        "accent":    "#3264eb",
        "selection": "#d0d8f8",
        "red":       "#d32f2f",
        "green":     "#388e3c",
        "yellow":    "#f57c00",
        "cyan":      "#0097a7",
    },
    "matte-black": {
        "mode": "dark",
        "bg":        "#121212",
        "bg_dark":   "#0a0a0a",
        "bg_darker": "#050505",
        "bg_light":  "#1e1e1e",
        "fg":        "#bebebe",
        "fg_dim":    "#5a5a5a",
        "fg_light":  "#929292",
        "accent":    "#e68e0d",
        "selection": "#2a2a2a",
        "red":       "#cf6679",
        "green":     "#81b58a",
        "yellow":    "#e68e0d",
        "cyan":      "#5ab4c5",
    },
    "miasma": {
        "mode": "dark",
        "bg":        "#222222",
        "bg_dark":   "#181818",
        "bg_darker": "#111111",
        "bg_light":  "#2e2e2e",
        "fg":        "#c2c2b0",
        "fg_dim":    "#5a5a50",
        "fg_light":  "#929280",
        "accent":    "#78824b",
        "selection": "#353530",
        "red":       "#cf6a4c",
        "green":     "#8f9d6a",
        "yellow":    "#f9ee98",
        "cyan":      "#afc4db",
    },
    "nord": {
        "mode": "dark",
        "bg":        "#2e3440",
        "bg_dark":   "#242933",
        "bg_darker": "#1c2128",
        "bg_light":  "#3b4252",
        "fg":        "#d8dee9",
        "fg_dim":    "#4c566a",
        "fg_light":  "#e5e9f0",
        "accent":    "#81a1c1",
        "selection": "#434c5e",
        "red":       "#bf616a",
        "green":     "#a3be8c",
        "yellow":    "#ebcb8b",
        "cyan":      "#88c0d0",
    },
    "osaka-jade": {
        "mode": "dark",
        "bg":        "#111c18",
        "bg_dark":   "#0b1410",
        "bg_darker": "#070d0a",
        "bg_light":  "#1a2b24",
        "fg":        "#C1C497",
        "fg_dim":    "#4a6050",
        "fg_light":  "#8a9c80",
        "accent":    "#509475",
        "selection": "#1c3828",
        "red":       "#d46060",
        "green":     "#509475",
        "yellow":    "#c4a060",
        "cyan":      "#60a890",
    },
    "retro-82": {
        "mode": "dark",
        "bg":        "#05182e",
        "bg_dark":   "#031020",
        "bg_darker": "#020c18",
        "bg_light":  "#0a2540",
        "fg":        "#f6dcac",
        "fg_dim":    "#4a6080",
        "fg_light":  "#c8a878",
        "accent":    "#faa968",
        "selection": "#0f3050",
        "red":       "#f04060",
        "green":     "#50d080",
        "yellow":    "#faa968",
        "cyan":      "#40c8d8",
    },
    "ristretto": {
        "mode": "dark",
        "bg":        "#2c2525",
        "bg_dark":   "#201a1a",
        "bg_darker": "#181010",
        "bg_light":  "#3a3030",
        "fg":        "#e6d9db",
        "fg_dim":    "#6a5050",
        "fg_light":  "#c0a8aa",
        "accent":    "#f38d70",
        "selection": "#4a3535",
        "red":       "#f38d70",
        "green":     "#80a870",
        "yellow":    "#d4a860",
        "cyan":      "#80b8c0",
    },
    "rose-pine": {
        "mode": "light",
        "bg":        "#faf4ed",
        "bg_dark":   "#f2e9e1",
        "bg_darker": "#e8ddd3",
        "bg_light":  "#eddfe0",
        "fg":        "#575279",
        "fg_dim":    "#9893a5",
        "fg_light":  "#6e6a86",
        "accent":    "#56949f",
        "selection": "#dfdad9",
        "red":       "#b4637a",
        "green":     "#618774",
        "yellow":    "#ea9d34",
        "cyan":      "#56949f",
    },
    "solitude": {
        "mode": "dark",
        "bg":        "#101315",
        "bg_dark":   "#0a0d0f",
        "bg_darker": "#060809",
        "bg_light":  "#1a2025",
        "fg":        "#cacccc",
        "fg_dim":    "#4a5055",
        "fg_light":  "#9aa0a0",
        "accent":    "#798186",
        "selection": "#202830",
        "red":       "#a05060",
        "green":     "#608070",
        "yellow":    "#a08060",
        "cyan":      "#608090",
    },
    "tokyo-night": {
        "mode": "dark",
        "bg":        "#1a1b26",
        "bg_dark":   "#13141f",
        "bg_darker": "#0d0e17",
        "bg_light":  "#24283b",
        "fg":        "#a9b1d6",
        "fg_dim":    "#565f89",
        "fg_light":  "#c0caf5",
        "accent":    "#7aa2f7",
        "selection": "#364a82",
        "red":       "#f7768e",
        "green":     "#9ece6a",
        "yellow":    "#e0af68",
        "cyan":      "#7dcfff",
    },
    "vantablack": {
        "mode": "dark",
        "bg":        "#000000",
        "bg_dark":   "#000000",
        "bg_darker": "#000000",
        "bg_light":  "#111111",
        "fg":        "#ffffff",
        "fg_dim":    "#555555",
        "fg_light":  "#aaaaaa",
        "accent":    "#8d8d8d",
        "selection": "#222222",
        "red":       "#ff5555",
        "green":     "#55ff55",
        "yellow":    "#ffff55",
        "cyan":      "#55ffff",
    },
    "white": {
        "mode": "light",
        "bg":        "#ffffff",
        "bg_dark":   "#f5f5f5",
        "bg_darker": "#ebebeb",
        "bg_light":  "#f0f0f0",
        "fg":        "#000000",
        "fg_dim":    "#888888",
        "fg_light":  "#444444",
        "accent":    "#6e6e6e",
        "selection": "#e0e0e0",
        "red":       "#cc0000",
        "green":     "#006600",
        "yellow":    "#cc6600",
        "cyan":      "#006688",
    },
    # aether lives in user themes dir
    "aether": {
        "mode": "dark",
        "bg":        "#0d1117",
        "bg_dark":   "#090c12",
        "bg_darker": "#05070d",
        "bg_light":  "#161b22",
        "fg":        "#c9d1d9",
        "fg_dim":    "#484f58",
        "fg_light":  "#8b949e",
        "accent":    "#58a6ff",
        "selection": "#1f3451",
        "red":       "#ff7b72",
        "green":     "#3fb950",
        "yellow":    "#d29922",
        "cyan":      "#39c5cf",
    },
}


def _alpha(hex_color: str, alpha: float) -> str:
    """Return an rgba() string for a hex colour.

    A user theme's colors.toml may hold a 3-digit hex, a named colour or an
    `rgb(...)`/`hsl(...)` string. Crashing here would abort the whole config
    load, so anything that is not a 3- or 6-digit hex is passed through
    unchanged — qutebrowser accepts those forms directly.
    """
    if not isinstance(hex_color, str):
        return hex_color
    h = hex_color.strip().lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    if len(h) != 6 or any(c not in "0123456789abcdefABCDEF" for c in h):
        return hex_color
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha})"


def apply_theme(c, theme_name: str | None = None):
    """Apply the Omarchy theme to a qutebrowser config object."""
    if theme_name is None:
        # 1. State file written by the theme-set hook (most up-to-date)
        import pathlib
        state_dir = pathlib.Path(os.environ.get("XDG_STATE_HOME", str(pathlib.Path.home() / ".local/state")))
        state_file = state_dir / "omarchy-qutebrowser" / "active-theme"
        if state_file.exists():
            theme_name = state_file.read_text().strip()
        # 2. Env var (set at launch time)
        if not theme_name:
            theme_name = os.environ.get("OMARCHY_THEME", "catppuccin")

    p = THEMES.get(theme_name)
    if p is None:
        # Try user theme from ~/.config/omarchy/themes/<name>/colors.toml
        import tomllib, pathlib
        user_path = pathlib.Path.home() / ".config/omarchy/themes" / theme_name / "colors.toml"
        if user_path.exists():
            with open(user_path, "rb") as f:
                raw = tomllib.load(f)
            mode = raw.get("mode", "dark")
            bg    = raw.get("background", "#1e1e2e")
            bg_dk = raw.get("dark_background", bg)
            bg_dkr= raw.get("darker_background", bg)
            bg_lt = raw.get("lighter_background", bg)
            fg    = raw.get("foreground", "#cdd6f4")
            fg_dm = raw.get("dark_foreground", fg)
            fg_lt = raw.get("light_foreground", fg)
            p = {
                "mode": mode,
                "bg": bg, "bg_dark": bg_dk, "bg_darker": bg_dkr, "bg_light": bg_lt,
                "fg": fg, "fg_dim": fg_dm, "fg_light": fg_lt,
                "accent":    raw.get("accent", "#89b4fa"),
                "selection": raw.get("selection", bg_lt),
                "red":       raw.get("red", "#f38ba8"),
                "green":     raw.get("green", "#a6e3a1"),
                "yellow":    raw.get("yellow", "#f9e2af"),
                "cyan":      raw.get("cyan", "#94e2d5"),
            }
        else:
            p = THEMES["catppuccin"]

    bg      = p["bg"]
    bg_dark = p["bg_dark"]
    bg_drk  = p["bg_darker"]
    bg_lt   = p["bg_light"]
    fg      = p["fg"]
    fg_dim  = p["fg_dim"]
    fg_lt   = p["fg_light"]
    acc     = p["accent"]
    sel     = p["selection"]
    red     = p["red"]
    green   = p["green"]
    yellow  = p["yellow"]
    cyan    = p["cyan"]

    # ── Completion ──────────────────────────────────────────────────────────
    c.colors.completion.fg                             = fg
    c.colors.completion.odd.bg                         = bg
    c.colors.completion.even.bg                        = bg_dark
    c.colors.completion.category.fg                    = acc
    c.colors.completion.category.bg                    = bg_drk
    c.colors.completion.category.border.top            = bg_drk
    c.colors.completion.category.border.bottom         = bg_drk
    c.colors.completion.item.selected.fg               = fg
    c.colors.completion.item.selected.bg               = sel
    c.colors.completion.item.selected.border.top       = sel
    c.colors.completion.item.selected.border.bottom    = sel
    c.colors.completion.item.selected.match.fg         = acc
    c.colors.completion.match.fg                       = acc
    c.colors.completion.scrollbar.fg                   = fg_dim
    c.colors.completion.scrollbar.bg                   = bg_dark

    # ── Context menu ────────────────────────────────────────────────────────
    c.colors.contextmenu.disabled.bg                   = bg_dark
    c.colors.contextmenu.disabled.fg                   = fg_dim
    c.colors.contextmenu.menu.bg                       = bg
    c.colors.contextmenu.menu.fg                       = fg
    c.colors.contextmenu.selected.bg                   = sel
    c.colors.contextmenu.selected.fg                   = fg

    # ── Downloads ────────────────────────────────────────────────────────────
    c.colors.downloads.bar.bg                          = bg_drk
    c.colors.downloads.start.fg                        = fg
    c.colors.downloads.start.bg                        = acc
    c.colors.downloads.stop.fg                         = fg
    c.colors.downloads.stop.bg                         = green
    c.colors.downloads.error.fg                        = red

    # ── Hints ────────────────────────────────────────────────────────────────
    c.colors.hints.fg                                  = bg_drk
    c.colors.hints.bg                                  = yellow
    c.colors.hints.match.fg                            = bg_drk

    # ── Keyhint ──────────────────────────────────────────────────────────────
    c.colors.keyhint.fg                                = fg
    c.colors.keyhint.suffix.fg                         = acc
    c.colors.keyhint.bg                                = _alpha(bg_dark, 0.9)

    # ── Messages ─────────────────────────────────────────────────────────────
    c.colors.messages.error.fg                         = bg_drk
    c.colors.messages.error.bg                         = red
    c.colors.messages.error.border                     = red
    c.colors.messages.warning.fg                       = bg_drk
    c.colors.messages.warning.bg                       = yellow
    c.colors.messages.warning.border                   = yellow
    c.colors.messages.info.fg                          = fg
    c.colors.messages.info.bg                          = bg_lt
    c.colors.messages.info.border                      = acc

    # ── Prompts ──────────────────────────────────────────────────────────────
    c.colors.prompts.fg                                = fg
    c.colors.prompts.border                            = acc
    c.colors.prompts.bg                                = bg
    c.colors.prompts.selected.fg                       = fg
    c.colors.prompts.selected.bg                       = sel

    # ── Statusbar ────────────────────────────────────────────────────────────
    c.colors.statusbar.normal.fg                       = fg
    c.colors.statusbar.normal.bg                       = bg_drk
    c.colors.statusbar.insert.fg                       = bg_drk
    c.colors.statusbar.insert.bg                       = acc
    c.colors.statusbar.passthrough.fg                  = bg_drk
    c.colors.statusbar.passthrough.bg                  = cyan
    c.colors.statusbar.private.fg                      = fg
    c.colors.statusbar.private.bg                      = bg_lt
    c.colors.statusbar.command.fg                      = fg
    c.colors.statusbar.command.bg                      = bg_drk
    c.colors.statusbar.command.private.fg              = fg
    c.colors.statusbar.command.private.bg              = bg_lt
    c.colors.statusbar.caret.fg                        = bg_drk
    c.colors.statusbar.caret.bg                        = acc
    c.colors.statusbar.caret.selection.fg              = bg_drk
    c.colors.statusbar.caret.selection.bg              = acc
    c.colors.statusbar.progress.bg                     = acc
    c.colors.statusbar.url.fg                          = fg
    c.colors.statusbar.url.error.fg                    = red
    c.colors.statusbar.url.hover.fg                    = fg_lt
    c.colors.statusbar.url.success.http.fg             = yellow
    c.colors.statusbar.url.success.https.fg            = green
    c.colors.statusbar.url.warn.fg                     = yellow

    # ── Tabs ─────────────────────────────────────────────────────────────────
    c.colors.tabs.bar.bg                               = bg_drk
    c.colors.tabs.indicator.start                      = acc
    c.colors.tabs.indicator.stop                       = green
    c.colors.tabs.indicator.error                      = red
    c.colors.tabs.odd.fg                               = fg_dim
    c.colors.tabs.odd.bg                               = bg_dark
    c.colors.tabs.even.fg                              = fg_dim
    c.colors.tabs.even.bg                              = bg
    c.colors.tabs.selected.odd.fg                      = fg
    c.colors.tabs.selected.odd.bg                      = bg_lt
    c.colors.tabs.selected.even.fg                     = fg
    c.colors.tabs.selected.even.bg                     = bg_lt
    c.colors.tabs.pinned.odd.fg                        = fg
    c.colors.tabs.pinned.odd.bg                        = bg_dark
    c.colors.tabs.pinned.even.fg                       = fg
    c.colors.tabs.pinned.even.bg                       = bg
    c.colors.tabs.pinned.selected.odd.fg               = fg
    c.colors.tabs.pinned.selected.odd.bg               = bg_lt
    c.colors.tabs.pinned.selected.even.fg              = fg
    c.colors.tabs.pinned.selected.even.bg              = bg_lt

    # ── Webpage ──────────────────────────────────────────────────────────────
    c.colors.webpage.bg                                = bg
    if p["mode"] == "dark":
        c.colors.webpage.preferred_color_scheme        = "dark"
    else:
        c.colors.webpage.preferred_color_scheme        = "light"

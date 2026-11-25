#!/usr/bin/env python3
"""Compile the filter lists' *cosmetic* rules into the Greasemonkey userscript.

qutebrowser's adblock refuses requests through the Brave engine and the host blocker; it
has no element hiding. That is only half of what uBlock Origin does, and it is the half
that leaves advertising visible: a publisher reserves its ad boxes in its own markup
(golem.de: `.go-ad-slot`, sponsored teasers, an "ANZEIGE" link block), the ad network is
refused, and empty labelled boxes stay on the page.

This tool reads the same lists config.py subscribes to and keeps the rules that CAN be
applied as CSS — `domain##selector` — dropping three kinds on purpose:

  * network rules (`||host^`, `@@`, anything with `$…`): qutebrowser already enforces them,
    and the Brave engine has them in `adblock-cache.dat`;
  * procedural filters (`:has-text(`, `:matches-css(`, `:style(`, `:upward(`, `-abp-`):
    valid uBlock syntax, not valid CSS — a stylesheet cannot express them;
  * generic rules with no domain (`##selector`): they apply to every site, and without
    uBlock's generic-exception machinery they are what breaks pages.

Output is the userscript itself with the rule table embedded (a Greasemonkey script cannot
read a local data file), written to the profile's greasemonkey directory, so the table never
drifts from the script that uses it. Regenerate with `bin/omarchy-cosmetic-update`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request

# The ad lists config.py subscribes to, minus the annoyances ones: hiding a share button
# or a newsletter box is a different decision from hiding advertising, and Fanboy's
# Annoyances rules do exactly that (golem.de: `.tags`, `.subscribe-newsletter`). Add a list
# with --source when that is what you want.
# Hand-checked rules for sites where the lists lag behind the markup; same syntax as a list.
DEFAULT_EXTRA = pathlib.Path(__file__).resolve().parent.parent / "config" / "cosmetic-extra.txt"

DEFAULT_SOURCES = (
    "https://easylist.to/easylist/easylist.txt",
    "https://easylist.to/easylistgermany/easylistgermany.txt",
)

# uBlock's procedural/extended syntax. `:has(` is deliberately NOT here: it is real CSS and
# QtWebEngine (Chromium 140) supports it, which several golem.de rules rely on.
PROCEDURAL = (
    ":has-text(", ":matches-css(", ":matches-attr(", ":matches-path(", ":matches-prop(",
    ":style(", ":remove(", ":upward(", ":watch-attr(", ":if(", ":if-not(", ":others(",
    ":nth-ancestor(", ":xpath(", ":min-text-length(", ":remove-attr(", ":remove-class(",
    "-abp-", ":-abp-", ":not(:has-text(",
)

DATA_PLACEHOLDER = "// @data"


def is_procedural(selector: str) -> bool:
    """True for a selector this tool cannot express as plain CSS."""
    return any(token in selector for token in PROCEDURAL)


def is_noise(line: str) -> bool:
    """True for blank lines, `!` comments and `[Adblock Plus 2.0]` headers."""
    return not line or line.startswith("!") or line.startswith("[")


def parse_cosmetic_rule(line: str) -> tuple[int, str, str] | None:
    """Split one filter-list line into (kind, domain, selector).

    kind is 0 for "hide" (`##`) and 1 for "allow" (`#@#`, an exception that removes a
    selector for a domain). Returns None for anything that is not a domain-scoped cosmetic
    rule: comments, headers, network rules, generic rules, procedural filters, and rules
    with wildcards or negated domains (both need uBlock's matcher, not a CSS map).
    """
    line = line.strip()
    if is_noise(line):
        return None
    if "#@#" in line:
        kind, sep = 1, "#@#"
    elif "##" in line:
        kind, sep = 0, "##"
    else:
        return None
    if "#?#" in line:                    # extended syntax, e.g. `:-abp-has(...)`
        return None
    domains, selector = line.split(sep, 1)
    domains, selector = domains.strip(), selector.strip()
    if not domains or not selector:
        return None                      # generic rule (`##selector`): skipped on purpose
    if is_procedural(selector):
        return None
    if any(token in domains for token in ("~", "*", "/", "^")):
        return None
    return kind, domains.lower(), selector


def collect(lines) -> dict[str, list[str]]:
    """Domain -> sorted list of selectors to hide, exceptions applied.

    An exception (`domain#@#selector`) removes exactly that selector from exactly that
    domain's list; it never adds anything, so a list cannot make this tool hide more.
    """
    hidden: dict[str, set] = {}
    allowed: set = set()
    for line in lines:
        parsed = parse_cosmetic_rule(line)
        if parsed is None:
            continue
        kind, domains, selector = parsed
        for domain in domains.split(","):
            domain = domain.strip()
            if not domain:
                continue
            if kind == 1:
                allowed.add((domain, selector))
            else:
                hidden.setdefault(domain, set()).add(selector)
    out = {}
    for domain, selectors in hidden.items():
        keep = sorted(selectors - {sel for (dom, sel) in allowed if dom == domain})
        if keep:
            out[domain] = keep
    return dict(sorted(out.items()))


def load_source(url: str, cache_dir: pathlib.Path, timeout: int = 60) -> list[str]:
    """Lines of one filter list, from the cache when a download fails."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / re.sub(r"[^A-Za-z0-9._-]", "_", url)
    if not re.match(r"^[a-z]+://", url):
        # A local file (config/cosmetic-extra.txt) — no cache, it is already on disk.
        return pathlib.Path(url).read_text(encoding="utf-8").splitlines()
    try:
        # easylist.to answers 403 to Python's default User-Agent (measured), so ask with a
        # browser-ish one; the filter lists are public static files and the request is a
        # plain GET.
        request = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) omarchy-qutebrowser"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
        cached.write_text(body, encoding="utf-8")
        return body.splitlines()
    except Exception as exc:                       # noqa: BLE001 - offline must not stop a rebuild
        if cached.exists():
            print(f"warning: {url}: {exc}; using the cached copy", file=sys.stderr)
            return cached.read_text(encoding="utf-8", errors="replace").splitlines()
        print(f"warning: {url}: {exc}; skipped", file=sys.stderr)
        return []


def render(template: str, data: dict) -> str:
    """The template with its `// @data` marker replaced by the rule table."""
    if DATA_PLACEHOLDER not in template:
        raise ValueError(f"template has no {DATA_PLACEHOLDER!r} marker")
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    lines = []
    for line in template.splitlines():
        if DATA_PLACEHOLDER in line:
            lines.append("var COSMETIC_DATA = " + payload + ";  // @data")
        else:
            lines.append(line)
    return "\n".join(lines) + "\n"


def build(sources, cache_dir: pathlib.Path) -> dict:
    """Compile every source into the rule table the userscript embeds."""
    domains: dict[str, set] = {}
    for url in sources:
        for line in load_source(url, cache_dir):
            parsed = parse_cosmetic_rule(line)
            if parsed is None:
                continue
            kind, domain_list, selector = parsed
            if kind != 0:
                continue
            for domain in domain_list.split(","):
                domain = domain.strip()
                if domain:
                    domains.setdefault(domain, set()).add(selector)
    return {"domains": {domain: sorted(selectors)
                        for domain, selectors in sorted(domains.items())}}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--output", required=True,
                        help="userscript to write (the profile's greasemonkey directory)")
    parser.add_argument("--template", required=True, help="userscripts/cosmetic-filters.js")
    parser.add_argument("--cache-dir", default=str(pathlib.Path.home() /
                                                   ".cache/omarchy-qutebrowser/cosmetic"))
    parser.add_argument("--source", action="append", default=None,
                        help="filter-list URL (repeatable; replaces the defaults: EasyList and "
                             "EasyList Germany — add Fanboy's Annoyances here if you want its "
                             "rules too)")
    parser.add_argument("--extra", default=None,
                        help="local file of additional `domain##selector` rules, compiled after "
                             "the lists (default: config/cosmetic-extra.txt in this repo)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the counts instead of writing the userscript")
    args = parser.parse_args(argv)

    sources = list(args.source or DEFAULT_SOURCES)
    # A missing extra file is an error whether it was named or defaulted: silently compiling
    # without it would drop the rules this plugin exists to add, and look like a clean run.
    extra = pathlib.Path(args.extra) if args.extra else DEFAULT_EXTRA
    if not extra.is_file():
        print(f"error: no extra rules file at {extra} (pass --extra, or restore "
              f"config/cosmetic-extra.txt)", file=sys.stderr)
        return 2
    sources.append(str(extra))
    template_path = pathlib.Path(args.template)
    data = build(sources, pathlib.Path(args.cache_dir))
    domains = data["domains"]
    selectors = sum(len(v) for v in domains.values())
    if args.dry_run:
        print(f"{len(domains)} domains, {selectors} selectors")
        return 0

    rendered = render(template_path.read_text(encoding="utf-8"), data)
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"wrote {output} — {len(domains)} domains, {selectors} selectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())

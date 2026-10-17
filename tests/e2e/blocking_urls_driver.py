#!/usr/bin/env python3
"""Fetch every list URL config.py configures, so a dead list URL is caught here instead
of as a 404 in qutebrowser's :adblock-update.

Prints one `E2E URL <code> <url>` line per list, or `E2E OFFLINE=1` when the network
itself is unreachable (in which case nothing is wrong with the URLs).
"""
import pathlib
import sys
import types
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[2]
CFG = REPO / "config"


class _Auto:
    def __getattr__(self, name):
        child = _Auto()
        setattr(self, name, child)
        return child

    def __call__(self, *a, **k):
        return None


class _ConfigStub:
    configdir = pathlib.Path.home() / ".config" / "qutebrowser"

    def bind(self, *a, **k):
        return None

    def set(self, *a, **k):
        return None

    def source(self, *a, **k):
        return None

    def load_autoconfig(self, *a, **k):
        return None


def configured_urls():
    c = _Auto()
    if str(CFG) not in sys.path:
        sys.path.insert(0, str(CFG))
    stub = types.ModuleType("omarchy_webauthn")
    setattr(stub, "install", lambda *a, **k: None)
    sys.modules["omarchy_webauthn"] = stub
    exec(compile((CFG / "config.py").read_text(), str(CFG / "config.py"), "exec"),
         {"c": c, "config": _ConfigStub(), "__file__": str(CFG / "config.py"),
          "__name__": "config"})
    urls = []
    for entry in list(c.content.blocking.adblock.lists) + list(c.content.blocking.hosts.lists):
        entry = str(entry)
        if entry.startswith("http"):
            urls.append(entry)
    return urls


def status(url):
    """HTTP status for url, or 0 when the request never got a response."""
    req = urllib.request.Request(url, headers={"User-Agent": "omarchy-qutebrowser-urlcheck"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            resp.read(256)
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0


urls = configured_urls()

# Probe one URL first: if nothing answers at all, the network is down, not the list.
first = status(urls[0]) if urls else 0
if first == 0:
    print("E2E OFFLINE=1")
    sys.exit(0)

print("URL %d %s" % (first, urls[0]))
for url in urls[1:]:
    print("URL %d %s" % (status(url), url))

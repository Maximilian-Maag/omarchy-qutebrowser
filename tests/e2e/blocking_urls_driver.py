#!/usr/bin/env python3
"""Fetch every list URL config.py configures, so a dead list URL is caught here instead
of as a 404 in qutebrowser's :adblock-update.

Prints one `E2E URL <code> <url>` line per list, or `E2E OFFLINE=1` when the network
itself is unreachable (in which case nothing is wrong with the URLs).
"""
import pathlib
import sys
import time
import types
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[2]
CFG = REPO / "config"

# A single request that never gets a response is far more often a transient DNS/TLS blip (or a
# slow list host) than a list that is gone — a CI runner hit exactly that on pgl.yoyo.org and
# turned the workflow red for a whole push. Retry, so the check measures the LIST, not the
# runner's luck; a host that is genuinely unreachable still reports 0 after the retries.
ATTEMPTS = 3
BACKOFF_SECONDS = 2


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


def attempt(url):
    """One HTTP request: the status code, or 0 when no response arrived."""
    req = urllib.request.Request(url, headers={"User-Agent": "omarchy-qutebrowser-urlcheck"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            resp.read(256)
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0


def status(url):
    """HTTP status for url, or 0 when the request never got a response after retries."""
    code = 0
    for index in range(ATTEMPTS):
        code = attempt(url)
        if code != 0:
            return code
        if index + 1 < ATTEMPTS:
            time.sleep(BACKOFF_SECONDS * (index + 1))
    return code


urls = configured_urls()
if not urls:
    print("E2E OFFLINE=1")
    sys.exit(0)

# Probe the first two URLs before fetching the rest: an offline runner fails fast here instead of
# burning a timeout per list. Two, not one, so a single flaky host cannot masquerade as "offline"
# and silently skip the whole check.
probe = urls[:2]
codes = {url: status(url) for url in probe}
if all(code == 0 for code in codes.values()):
    print("E2E OFFLINE=1")
    sys.exit(0)

for url in urls[2:]:
    codes[url] = status(url)
for url in urls:
    print("URL %d %s" % (codes[url], url))

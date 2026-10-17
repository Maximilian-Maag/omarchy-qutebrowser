"""Integration: execute config/config.py the way qutebrowser does and inspect the result.

The regression tests grep config.py's text; this one actually RUNS it with a stub `c` and
`config` (the objects qutebrowser injects) and reads the blocking settings back. That is
what catches a config that is syntactically fine but raises on load, or that wires a list
into the wrong place — a broken config.py means the browser starts with an error banner.
"""
import pathlib
import sys
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
CFG = REPO / "config"


class _Auto:
    """Auto-vivifying attribute tree, so `c.content.blocking.adblock.lists = [...]` works."""
    def __getattr__(self, name):
        child = _Auto()
        setattr(self, name, child)
        return child

    def __call__(self, *args, **kwargs):    # qutebrowser's dict-likes: c.aliases.update(...)
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


def load_config():
    """Exec config.py with stubs and return the stub `c`."""
    c = _Auto()
    config = _ConfigStub()
    if str(CFG) not in sys.path:
        sys.path.insert(0, str(CFG))
    # omarchy_webauthn.install() pulls in Qt; config.py guards the import, so stub it to
    # keep this test headless and deterministic.
    stub = types.ModuleType("omarchy_webauthn")
    setattr(stub, "install", lambda *a, **k: None)
    saved = sys.modules.get("omarchy_webauthn")
    sys.modules["omarchy_webauthn"] = stub
    try:
        src = (CFG / "config.py").read_text()
        exec(compile(src, str(CFG / "config.py"), "exec"),
             {"c": c, "config": config, "__file__": str(CFG / "config.py"),
              "__name__": "config"})
    finally:
        if saved is None:
            sys.modules.pop("omarchy_webauthn", None)
        else:
            sys.modules["omarchy_webauthn"] = saved
    return c


class BlockingConfigCase(unittest.TestCase):
    def setUp(self):
        self.c = load_config()
        self.blk = self.c.content.blocking

    def test_config_loads_and_enables_both_methods(self):
        self.assertTrue(self.blk.enabled)
        self.assertEqual(self.blk.method, "both")
        self.assertTrue(self.blk.hosts.block_subdomains)

    def test_our_own_lists_come_first(self):
        lists = list(self.blk.adblock.lists)
        self.assertGreaterEqual(len(lists), 2)
        for idx, name in enumerate(("youtube-ads.txt", "trackers.txt")):
            path = pathlib.Path(lists[idx])
            self.assertEqual(path.name, name, "list %d must be our %s" % (idx, name))
            self.assertEqual(path.parent, CFG / "blocking")
            self.assertTrue(path.is_file(), "%s must exist" % path)

    def test_tracker_and_ad_lists_present(self):
        joined = "\n".join(str(x) for x in self.blk.adblock.lists)
        for needle in ("easyprivacy", "easylistgermany", "fanboy-social",
                       "filters/social.txt", "filters/quick-fixes.txt",
                       "filters/3.txt", "nocoin"):
            self.assertIn(needle, joined)

    def test_hosts_lists_cover_trackers(self):
        hosts = "\n".join(str(x) for x in self.blk.hosts.lists)
        for needle in ("StevenBlack", "hagezi", "adservers", "someonewhocares"):
            self.assertIn(needle, hosts)


if __name__ == "__main__":
    unittest.main()

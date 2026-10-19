"""Integration: the stock-Chrome identity config.py applies per host.

Executes config/config.py the way qutebrowser does (stub `c`/`config`) with a config stub that
RECORDS every `config.set(option, value, pattern)` call, then checks the per-host overrides.

Why this exists: LinkedIn/Cloudflare, Kleinanzeigen and immowelt/DataDome answer a QtWebEngine
client with a bot interstitial. The fix is a host-scoped stock-Chrome identity - a User-Agent
without the QtWebEngine token, client hints that agree with it, a readable canvas, no
Do-Not-Track. Those are `config.set(..., pattern)` calls, which the blocking-config test's
no-op stub cannot see, so this test records them. The JavaScript half is covered separately
(tests/js/chrome-identity.test.js, tests/test_regression_signin_untouched.py).
"""
import pathlib
import sys
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
CFG = REPO / "config"

# The hosts that must get the identity (substring of one or more patterns each).
BOT_MANAGED = ("linkedin.com", "kleinanzeigen.de", "immowelt.de")
SIGNIN = ("accounts.google.com", "login.microsoftonline.com")


class _Auto:
    """Auto-vivifying attribute tree, so `c.content.canvas_reading = False` works."""

    def __getattr__(self, name):
        child = _Auto()
        setattr(self, name, child)
        return child

    def __call__(self, *args, **kwargs):
        return None


class _RecordingConfig:
    def __init__(self, configdir=None):
        self.configdir = configdir or (pathlib.Path.home() / ".config" / "qutebrowser")
        self.sets = []          # (option, value, pattern)

    def bind(self, *a, **k):
        return None

    def set(self, option, value, pattern=None):
        self.sets.append((option, value, pattern))

    def source(self, *a, **k):
        return None

    def load_autoconfig(self, *a, **k):
        return None


def load_config(configdir=None):
    c = _Auto()
    config = _RecordingConfig(configdir)
    if str(CFG) not in sys.path:
        sys.path.insert(0, str(CFG))
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
    return c, config


class StockChromeIdentity(unittest.TestCase):
    def setUp(self):
        self.c, self.config = load_config()

    def patterns(self, option):
        return [p for (o, _v, p) in self.config.sets if o == option]

    def patterns_matching(self, option, host):
        return [p for p in self.patterns(option) if p and host in p]

    def value_for(self, option, host):
        for (o, v, p) in self.config.sets:
            if o == option and p and host in p:
                return v
        return None

    def test_each_bot_managed_host_gets_a_user_agent_without_qtwebengine(self):
        for host in BOT_MANAGED:
            matches = self.patterns_matching("content.headers.user_agent", host)
            self.assertTrue(matches, "no User-Agent override for %s" % host)
            ua = self.value_for("content.headers.user_agent", host)
            self.assertIsInstance(ua, str, "no User-Agent override for %s" % host)
            self.assertNotIn("QtWebEngine", ua, "%s still advertises QtWebEngine" % host)
            self.assertIn("Chrome/", ua, "%s UA lost its Chrome version" % host)

    def test_each_bot_managed_host_gets_client_hints_agreeing_with_the_ua(self):
        for host in BOT_MANAGED:
            hints = self.value_for("content.headers.custom", host)
            self.assertIsInstance(hints, dict, "no client-hint override for %s" % host)
            # QtWebEngine says "Chromium" only; a Chrome UA needs a Google Chrome brand.
            self.assertIn("Google Chrome", hints.get("sec-ch-ua", ""))
            self.assertEqual(hints.get("sec-ch-ua-platform"), '"Linux"')

    def test_each_bot_managed_host_reads_a_canvas_and_sends_no_dnt(self):
        for host in BOT_MANAGED:
            self.assertIn(True, [v for (o, v, p) in self.config.sets
                                 if o == "content.canvas_reading" and p and host in p],
                          "canvas_reading not enabled for %s" % host)
            self.assertIn(False, [v for (o, v, p) in self.config.sets
                                  if o == "content.headers.do_not_track" and p and host in p],
                          "Do-Not-Track not disabled for %s" % host)

    def test_each_bot_managed_host_gets_third_party_cookies(self):
        for host in BOT_MANAGED:
            self.assertIn("all", [v for (o, v, p) in self.config.sets
                                  if o == "content.cookies.accept" and p and host in p],
                          "third-party cookies not allowed for %s" % host)

    def test_the_identity_stays_on_those_hosts_everywhere_else_stays_strict(self):
        # The whole point of a host-scoped exception: the global defaults must not move.
        self.assertIs(self.c.content.canvas_reading, False,
                      "the global canvas default must stay strict")
        self.assertIs(self.c.content.headers.do_not_track, True,
                      "the global Do-Not-Track default must stay strict")
        self.assertEqual(self.c.content.cookies.accept, "no-3rdparty",
                         "the global cookie policy must stay strict")
        # No override may be patternless (that would leak the identity onto every site).
        for option in ("content.headers.user_agent", "content.headers.custom",
                       "content.canvas_reading", "content.headers.do_not_track",
                       "content.cookies.accept"):
            for (o, _v, p) in self.config.sets:
                if o == option:
                    self.assertIsNotNone(p, "%s was set globally, not per host" % option)

    def test_the_signin_hosts_are_still_covered(self):
        # The extension must not drop the Google/Microsoft sign-in hosts it grew out of.
        for host in SIGNIN:
            self.assertTrue(self.patterns_matching("content.headers.user_agent", host),
                            "sign-in host %s lost its User-Agent override" % host)


if __name__ == "__main__":
    unittest.main()

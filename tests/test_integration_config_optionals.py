"""Integration: the conditional parts of config.py — personal overrides and the escape hatch.

Both behaviours here are conditional by design, and a conditional that never ran is the same as
no feature at all:

  * `user-config.py` is sourced LAST, so a personal font size or key wins over the plugin's own
    defaults, but only when the file exists — sourcing a missing file makes qutebrowser record a
    config error on every start, which is why the two neighbouring sources are guarded the same
    way;
  * `,w` hands the current page to a real Chromium (the only thing on this desktop that can pass
    a Cloudflare Turnstile / DataDome widget, which QtWebEngine cannot) and is bound only where
    Chromium is installed, so a host without it gets no dead key.

config.py is executed with the recording stubs from test_integration_config_bindings; that also
gives the shipped-bindings check in BindingsDoNotShadowCase.
"""
import os
import pathlib
import stat
import tempfile
import unittest

try:                                        # `python3 -m unittest discover -s tests`
    from test_integration_config_bindings import load_config
except ImportError:                         # `python3 -m unittest tests.test_integration_...`
    from tests.test_integration_config_bindings import load_config


class UserConfigCase(unittest.TestCase):
    """A personal overrides file next to config.py is honoured, and absence is not an error."""

    def test_sourced_last_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "user-config.py").write_text("c.fonts.default_size = '28pt'\n")
            config = load_config(configdir=tmp)
        self.assertIn("user-config.py", config.sources,
                      "an existing user-config.py was never sourced")
        self.assertEqual(config.sources[-1], "user-config.py",
                         "user-config.py must be sourced LAST so it wins over the plugin's own "
                         "settings (got sources %r)" % (config.sources,))

    def test_not_sourced_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(configdir=tmp)
        self.assertNotIn("user-config.py", config.sources,
                         "sourcing a missing user-config.py records a config error on every start")

    def test_the_guard_can_still_tell_the_two_apart(self):
        # The two cases above only mean something if presence is what decides: same directory,
        # one file added, and the source appears.
        with tempfile.TemporaryDirectory() as tmp:
            before = load_config(configdir=tmp).sources
            (pathlib.Path(tmp) / "user-config.py").write_text("")
            after = load_config(configdir=tmp).sources
        self.assertNotIn("user-config.py", before)
        self.assertIn("user-config.py", after)


class ChromiumEscapeCase(unittest.TestCase):
    """`,w` exists only where a Chromium binary does."""

    def _load_with_path(self, tmp):
        saved = os.environ.get("PATH", "")
        os.environ["PATH"] = tmp
        try:
            return load_config()
        finally:
            os.environ["PATH"] = saved

    def test_bound_when_chromium_is_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            stub = pathlib.Path(tmp) / "chromium"
            stub.write_text("#!/bin/bash\nexit 0\n")
            stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
            config = self._load_with_path(tmp)
        binds = [b for b in config.binds if b[1] == ",w"]
        self.assertEqual(len(binds), 1, "`,w` is not bound although chromium is on PATH")
        self.assertEqual(binds[0][2], "spawn chromium {url}",
                         "`,w` must hand the URL to chromium (got %r)" % (binds[0][2],))

    def test_not_bound_when_chromium_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = self._load_with_path(tmp)
        self.assertEqual([b for b in config.binds if b[1] == ",w"], [],
                         "`,w` is bound although there is no chromium to run")


class BindingsDoNotShadowCase(unittest.TestCase):
    """No shipped binding may be the prefix of another — qutebrowser would silently drop it.

    A binding whose first key is itself bound stops the longer one from firing, and nothing is
    logged: `,cc` would kill `,c` (reader fact-check), which is why the Chromium hatch is `,w`.
    """

    def test_no_binding_is_a_prefix_of_another(self):
        binds = load_config().binds
        sequences = sorted({sequence for (_mode, sequence, _command) in binds})
        shadows = [(short, long) for short in sequences for long in sequences
                   if long != short and long.startswith(short)]
        self.assertEqual(shadows, [],
                         "a binding is a prefix of another, so the shorter one goes dead: %r"
                         % (shadows,))


if __name__ == "__main__":
    unittest.main()

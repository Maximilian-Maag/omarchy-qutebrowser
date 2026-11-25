"""Integration: execute config/config.py the way qutebrowser does and inspect the result.

The regression tests grep config.py's text; this one actually RUNS it with a stub `c` and
`config` (the objects qutebrowser injects) and reads the blocking settings back. That is
what catches a config that is syntactically fine but raises on load, or that wires a list
into the wrong place — a broken config.py means the browser starts with an error banner.

It also drives the adblock staleness decision and the refresh callback by injecting the
qutebrowser modules they import: no browser, no network, no sleeping, and no dependence on
the machine's real adblock-cache.dat.
"""
import contextlib
import os
import pathlib
import sys
import tempfile
import time
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
    def __init__(self, configdir=None):
        self.configdir = configdir or (pathlib.Path.home() / ".config" / "qutebrowser")

    def bind(self, *a, **k):
        return None

    def set(self, *a, **k):
        return None

    def source(self, *a, **k):
        return None

    def load_autoconfig(self, *a, **k):
        return None


def load_config_ns(configdir=None):
    """Exec config.py with stubs and return `(c, namespace)`.

    The namespace is what a test needs to reach the module-level helpers (the adblock
    staleness decision and the refresh callback) without importing config.py, which is not
    a module qutebrowser ever imports.
    """
    c = _Auto()
    config = _ConfigStub(configdir)
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
        ns = {"c": c, "config": config, "__file__": str(CFG / "config.py"),
              "__name__": "config"}
        exec(compile(src, str(CFG / "config.py"), "exec"), ns)
    finally:
        if saved is None:
            sys.modules.pop("omarchy_webauthn", None)
        else:
            sys.modules["omarchy_webauthn"] = saved
    return c, ns


def load_config(configdir=None):
    """Exec config.py with stubs and return the stub `c`."""
    return load_config_ns(configdir)[0]


_MISSING = object()


@contextlib.contextmanager
def _patched(modules):
    """Temporarily replace sys.modules entries; a value of None makes the import fail.

    `None` is how config.py sees a machine without Qt: CPython raises ImportError for a
    module set to None, which is the same exception an absent PyQt produces.
    """
    saved = {name: sys.modules.get(name, _MISSING) for name in modules}
    sys.modules.update(modules)
    try:
        yield
    finally:
        for name, old in saved.items():
            if old is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old


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

    def test_our_lists_are_found_without_the_installed_symlink(self):
        """CI has no ~/.config/qutebrowser/config.py to resolve through.

        Resolving our lists via that symlink returned None there, so the two lists dropped
        out of `adblock.lists` and easylist silently became first: the exact CI failure
        (`AssertionError: 'easylist.txt' != 'youtube-ads.txt'`). Locally the symlink exists,
        which is why this only ever failed on the runner.
        """
        with tempfile.TemporaryDirectory() as tmp:
            c = load_config(configdir=pathlib.Path(tmp) / "qutebrowser")
            lists = list(c.content.blocking.adblock.lists)      # type: ignore[arg-type]
            self.assertEqual(pathlib.Path(lists[0]).name, "youtube-ads.txt")
            self.assertEqual(pathlib.Path(lists[1]).name, "trackers.txt")

    def test_tracker_and_ad_lists_present(self):
        joined = "\n".join(str(x) for x in self.blk.adblock.lists)
        for needle in ("easyprivacy", "easylistgermany", "fanboy-annoyance",
                       "filters-general.txt", "filters/quick-fixes.txt",
                       "filters/3.txt", "nocoin"):
            self.assertIn(needle, joined)

    def test_no_list_is_configured_twice(self):
        """A duplicated URL is downloaded and parsed twice and can never add a rule."""
        urls = [str(x) for x in self.blk.adblock.lists]
        self.assertEqual(len(urls), len(set(urls)),
                         "duplicate list URL(s): %r" % urls)

    def test_lists_that_were_subsets_stay_gone(self):
        """These three were dropped because a kept list already carries them.

        fanboy-social is 100% contained in fanboy-annoyance; fanboy-cookiemonster is
        contained for every network rule (its 43 leftovers are cosmetic rules qutebrowser
        never applies); uAssets/filters/annoyances.txt is only an `!#include` stub, which
        nothing expands, so it contributed no rules at all.
        """
        joined = "\n".join(str(x) for x in self.blk.adblock.lists)
        for needle in ("fanboy-social.txt", "fanboy-cookiemonster.txt",
                       "filters/annoyances.txt"):
            self.assertNotIn(needle, joined, "%s is a subset of a kept list" % needle)
        # ...and the list that does the carrying is still there.
        self.assertIn("fanboy-annoyance.txt", joined)

    def test_hosts_lists_cover_trackers(self):
        hosts = "\n".join(str(x) for x in self.blk.hosts.lists)
        for needle in ("StevenBlack", "hagezi", "frogeye", "adservers", "someonewhocares"):
            self.assertIn(needle, hosts)


class AdblockStalenessCase(unittest.TestCase):
    """The decision must be a pure function of two timestamps, so it can be tested here."""

    def setUp(self):
        self._c, ns = load_config_ns()
        self.state = ns["adblock_cache_state"]
        self.refresh = ns["adblock_refresh"]
        self.delay_ms = ns["_ADBLOCK_REFRESH_DELAY_MS"]
        self.now = 1_800_000_000            # a fixed clock; nothing reads the real one

    def test_fresh_within_seven_days(self):
        for age in (0, 3600, 6 * 86400, 7 * 86400):
            self.assertEqual(self.state(self.now - age, self.now), "fresh",
                             "a cache %d s old is not stale" % age)

    def test_stale_once_older_than_seven_days(self):
        for age in (7 * 86400 + 1, 30 * 86400):
            self.assertEqual(self.state(self.now - age, self.now), "stale",
                             "a cache %d s old must refresh" % age)

    def test_missing_cache_is_reported_as_missing(self):
        self.assertEqual(self.state(None, self.now), "missing")

    def test_a_future_mtime_is_fresh(self):
        """Clock skew must not turn into a download on every start."""
        self.assertEqual(self.state(self.now + 86400, self.now), "fresh")


class AdblockRefreshCase(unittest.TestCase):
    """The callback refreshes exactly when it should, and reports instead of raising."""

    def setUp(self):
        self._c, self.ns = load_config_ns()
        self.refresh = self.ns["adblock_refresh"]
        self.delay_ms = self.ns["_ADBLOCK_REFRESH_DELAY_MS"]
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = pathlib.Path(self._tmp.name) / "adblock-cache.dat"

    def _cache(self, age_seconds):
        self.path.write_bytes(b"parsed lists")
        when = time.time() - age_seconds
        os.utime(self.path, (when, when))
        return self.path

    def _modules(self, update_error=None, dependency_loaded=True):
        calls = []
        components = types.ModuleType("qutebrowser.components")
        commands = types.ModuleType("qutebrowser.components.adblockcommands")
        brave = types.ModuleType("qutebrowser.components.braveadblock")

        def _update():
            if update_error is not None:
                raise update_error
            calls.append("adblock-update")

        commands.adblock_update = _update
        brave.ad_blocker = object() if dependency_loaded else None
        components.adblockcommands = commands
        components.braveadblock = brave

        messages = []
        api = types.ModuleType("qutebrowser.api")
        api.message = types.SimpleNamespace(info=messages.append)
        return {"qutebrowser.components": components,
                "qutebrowser.api": api}, calls, messages

    def test_a_fresh_cache_downloads_nothing(self):
        self._cache(2 * 86400)
        modules, calls, _messages = self._modules()
        with _patched(modules):
            self.refresh(path=str(self.path))
        self.assertEqual(calls, [], "a cache two days old must not be re-downloaded")

    def test_a_stale_cache_downloads_the_lists(self):
        self._cache(8 * 86400)
        modules, calls, _messages = self._modules()
        with _patched(modules):
            self.refresh(path=str(self.path))
        self.assertEqual(calls, ["adblock-update"])

    def test_a_missing_cache_downloads_the_lists(self):
        modules, calls, _messages = self._modules()
        with _patched(modules):
            self.refresh(path=str(self.path))
        self.assertEqual(calls, ["adblock-update"],
                         "no cache at all means nothing is blocked yet")

    def test_a_failing_refresh_tells_the_user_instead_of_raising(self):
        self._cache(8 * 86400)
        modules, calls, messages = self._modules(update_error=RuntimeError("no network"))
        with _patched(modules):
            self.refresh(path=str(self.path))       # must not raise
        self.assertEqual(calls, [])
        self.assertEqual(len(messages), 1, "a failed refresh must be visible, not silent")
        self.assertIn(",ab", messages[0])
        self.assertIn("8 days old", messages[0])

    def test_an_unloaded_dependency_is_reported_not_faked(self):
        self._cache(8 * 86400)
        modules, calls, messages = self._modules(dependency_loaded=False)
        with _patched(modules):
            self.refresh(path=str(self.path))
        self.assertEqual(calls, [])
        self.assertEqual(len(messages), 1)
        self.assertIn("adblock", messages[0])

    def test_the_configured_refresh_delay_gives_the_first_page_time(self):
        self.assertGreaterEqual(self.delay_ms, 5000,
                                "refreshing during startup would compete with the first load")

    def test_a_fresh_cache_is_never_refreshed_by_a_missing_dependency(self):
        """Order matters: a fresh cache must not even look at the blocker."""
        self._cache(0)
        modules, calls, messages = self._modules(dependency_loaded=False)
        with _patched(modules):
            self.refresh(path=str(self.path))
        self.assertEqual(calls, [])
        self.assertEqual(messages, [])


class AdblockSchedulingCase(unittest.TestCase):
    """config.py schedules the timer exactly once per process, and only with an event loop."""

    def setUp(self):
        self.flag = "_omarchy_qutebrowser_adblock_scheduled"
        sys.modules.pop("qutebrowser.qt.core", None)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        try:
            delattr(sys, self.flag)
        except AttributeError:
            pass

    def _qt(self, with_app, with_windows=True):
        scheduled = []
        module = types.ModuleType("qutebrowser.qt.core")

        class _App:
            @staticmethod
            def instance():
                return object() if with_app else None

        class _Timer:
            @staticmethod
            def singleShot(delay, callback):
                scheduled.append((delay, callback))

        module.QCoreApplication = _App
        module.QTimer = _Timer

        # config.py asks the window registry whether this is the browser or the CLI.
        utils = types.ModuleType("qutebrowser.utils")
        registry = types.ModuleType("qutebrowser.utils.objreg")
        registry.window_registry = {0: object()} if (with_app and with_windows) else {}
        return {"qutebrowser.qt.core": module,
                "qutebrowser.utils": utils,
                "qutebrowser.utils.objreg": registry}, scheduled

    def test_schedules_once_per_session_even_when_config_is_ressourced(self):
        modules, scheduled = self._qt(with_app=True)
        with _patched(modules):
            load_config()
            load_config()          # what :config-source does: a fresh exec of config.py
        self.assertEqual(len(scheduled), 1,
                         "every :config-source would otherwise start another download")
        delay, callback = scheduled[0]
        self.assertEqual(delay, 15_000)
        self.assertEqual(callback.__name__, "adblock_refresh")

    def test_schedules_nothing_without_an_event_loop(self):
        modules, scheduled = self._qt(with_app=False)
        with _patched(modules):
            load_config()
        self.assertEqual(scheduled, [], "no QCoreApplication means the timer could never fire")

    def test_schedules_nothing_in_a_cli_process_that_has_no_window(self):
        # `qutebrowser :command` has a QCoreApplication but no window and a dispatcher that
        # is destroyed at exit; a timer there only earns Qt's "event dispatcher has already
        # been destroyed" warning on every invocation.
        modules, scheduled = self._qt(with_app=True, with_windows=False)
        with _patched(modules):
            load_config()
        self.assertEqual(scheduled, [],
                         "a CLI process with no window must not schedule the refresh")

    def test_sourcing_works_when_qt_cannot_be_imported(self):
        """PyQt absent is the headless case: config.py must still load."""
        with _patched({"qutebrowser.qt.core": None}):
            c = load_config()
        self.assertTrue(c.content.blocking.adblock.lists)


if __name__ == "__main__":
    unittest.main()

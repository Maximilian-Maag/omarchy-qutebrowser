"""Unit tests for config/omarchy_crashguard.py - reload a tab whose renderer died.

The crash is an engine bug on the stable channel (QtWebEngine 6.11.2, QTBUG-149435), so the
only thing this module can do is make it cost a reload instead of a dead tab. The budget is
the whole point: two reloads per URL per five minutes. A test that only proved "it reloads"
would pass against a version that reloads forever, which is worse than the bug.
"""
import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[1] / "config" / "omarchy_crashguard.py"
WINDOW = 5 * 60 * 1000


def load():
    spec = importlib.util.spec_from_file_location("crashguard_under_test", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Budget(unittest.TestCase):
    def setUp(self):
        self.cg = load()
        self.url = "https://forum.golem.de/read.php?1,12345"
        self.history = []

    def crash(self, now):
        return self.cg.handle_termination(self.url, now, self.history, True)

    def test_two_reloads_then_it_gives_up(self):
        self.assertTrue(self.crash(1000))
        self.assertTrue(self.crash(2000))
        # the third crash of the same page must NOT reload: qutebrowser's error page stays
        self.assertFalse(self.crash(3000))
        self.assertFalse(self.crash(4000))

    def test_the_budget_refills_after_the_window(self):
        self.assertTrue(self.crash(1000))
        self.assertTrue(self.crash(2000))
        self.assertFalse(self.crash(3000))
        # one millisecond before the first attempt ages out there is still no budget
        self.assertFalse(self.crash(1000 + WINDOW - 1))
        # …and exactly at the edge the first attempt is gone, so one reload is left
        self.assertTrue(self.crash(1000 + WINDOW))

    def test_a_non_crash_termination_is_left_alone(self):
        self.assertFalse(self.cg.handle_termination(self.url, 1000, self.history, False))
        self.assertEqual(self.history, [], "nothing was booked against the budget")

    def test_internal_pages_are_not_reloaded(self):
        for url in ("qute://version", "about:blank", "chrome-error://chromewebdata/",
                    "data:text/html,x", "view-source:https://a.test/", ""):
            self.assertFalse(self.cg.handle_termination(url, 1000, [], True), url)

    def test_each_url_has_its_own_budget(self):
        self.assertTrue(self.crash(1000))
        self.assertTrue(self.crash(2000))
        self.assertFalse(self.crash(3000))
        other = []
        self.assertTrue(self.cg.handle_termination("https://a.test/", 3000, other, True),
                        "a crash on another page is unrelated")

    def test_aged_out_attempts_are_pruned_not_accumulated(self):
        history = [0, 1]
        self.cg.record_attempt(history, WINDOW + 5)
        self.assertEqual(history, [WINDOW + 5], "the two stale entries are dropped")
        self.cg.record_attempt(history, WINDOW + 10)
        self.assertEqual(history, [WINDOW + 5, WINDOW + 10])

    def test_recent_attempts_keeps_order(self):
        self.assertEqual(self.cg.recent_attempts([5, 1, 3], 10, window=100), [5, 1, 3])
        self.assertEqual(self.cg.recent_attempts([5, 1, 3], 10, window=6), [5])


class RememberUrl(unittest.TestCase):
    """The tab is already on qutebrowser's data: error page when our slot runs."""

    def test_the_error_page_does_not_overwrite_the_real_url(self):
        cg = load()
        store = {}
        cg.remember(store, "t1", "https://forum.golem.de/read.php?1,2")
        cg.remember(store, "t1", "data:text/html;charset=UTF-8,%3Cp%3EError")
        self.assertEqual(store["t1"], "https://forum.golem.de/read.php?1,2")
        self.assertEqual(cg.remember(store, "t1", "chrome-error://chromewebdata/"),
                         "https://forum.golem.de/read.php?1,2")

    def test_an_unknown_tab_has_no_url(self):
        cg = load()
        self.assertEqual(cg.remember({}, "t2", "data:text/html,x"), "")
        self.assertEqual(cg.remember({}, "t2", "https://a.test/"), "https://a.test/")


class Attach(unittest.TestCase):
    """attach() connects once per page, and the slot reloads through setUrl."""

    class Signal:
        def __init__(self):
            self.slots = []

        def connect(self, slot):
            self.slots.append(slot)

    def page(self, url="https://forum.golem.de/"):
        class Url:
            def __init__(self, value):
                self.value = value

            def toString(self):
                return self.value

        class Page:
            def __init__(self, url):
                self.urlChanged = Attach.Signal()
                self.renderProcessTerminated = Attach.Signal()
                self._url = Url(url)
                self.visited = []

            def url(self):
                return self._url

            def setUrl(self, qurl):
                # a real QUrl's toString() is the URL; str() is its repr
                self.visited.append(qurl.toString())

        return Page(url)

    def message(self):
        class Message:
            """qutebrowser's message module: info()/warning() are functions, not lists."""

            def __init__(self):
                self.infos = []
                self.warnings = []

            def info(self, text, *args, **kwargs):
                self.infos.append(text)

            def warning(self, text, *args, **kwargs):
                self.warnings.append(text)

        return Message()

    def test_attach_is_idempotent(self):
        cg = load()
        page = self.page()
        self.assertTrue(cg.attach(page, lambda: 1000, self.message()))
        self.assertFalse(cg.attach(page, lambda: 1000, self.message()))
        self.assertEqual(len(page.renderProcessTerminated.slots), 1,
                         "a second sweep must not connect a second slot")

    def test_a_crash_sends_the_page_back_to_where_it_was(self):
        cg = load()
        page = self.page("https://forum.golem.de/read.php?1,2")
        msg = self.message()
        cg.attach(page, lambda: 1000, msg)
        crash, code = "RenderProcessTerminationStatus.CrashedTerminationStatus", 133
        page.renderProcessTerminated.slots[0](crash, code)
        self.assertEqual(page.visited, ["https://forum.golem.de/read.php?1,2"])
        self.assertEqual(len(msg.infos), 1)
        self.assertIn("attempt 1/2", msg.infos[0])

    def test_the_error_page_url_is_never_reloaded(self):
        cg = load()
        page = self.page("https://forum.golem.de/")
        msg = self.message()
        cg.attach(page, lambda: 1000, msg)
        # qutebrowser swaps the page to a data: error page before our slot runs
        page.urlChanged.slots[0](type("U", (), {"toString": lambda self: "data:text/html,x"})())
        page.renderProcessTerminated.slots[0](
            "RenderProcessTerminationStatus.CrashedTerminationStatus", 133)
        self.assertEqual(page.visited, ["https://forum.golem.de/"],
                         "it goes back to the page that crashed, not the error page")

    def test_the_budget_is_spent_across_real_slots(self):
        cg = load()
        page = self.page("https://a.test/")
        msg = self.message()
        cg.attach(page, lambda: 5000, msg)
        slot = page.renderProcessTerminated.slots[0]
        crash = "RenderProcessTerminationStatus.CrashedTerminationStatus"
        slot(crash, 133)
        slot(crash, 133)
        slot(crash, 133)                     # third: no reload, only the warning
        self.assertEqual(len(page.visited), 2)
        self.assertEqual(len(msg.warnings), 1)
        self.assertIn("keeps crashing", msg.warnings[0])


if __name__ == "__main__":
    unittest.main()
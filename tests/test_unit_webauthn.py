"""Unit tests for config/omarchy_webauthn.py - the WebAuthn UX handler.

qutebrowser never connects QWebEnginePage.webAuthUxRequested, so a passkey ceremony waits forever:
no dialog, no result. This module answers the request. The tests drive the state machine with
fakes - no Qt, no browser, no security key - and assert exactly what the handler does with each
state, because that is the difference between a prompt appearing and the ceremony hanging.
"""
import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[1] / "config" / "omarchy_webauthn.py"


def load():
    spec = importlib.util.spec_from_file_location("webauthn_under_test", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Signal:
    def __init__(self):
        self.slots = []

    def connect(self, slot):
        self.slots.append(slot)


class State:
    def __init__(self, name):
        self.name = name


class Request:
    """A stand-in for QWebEngineWebAuthUxRequest: every getter is a METHOD, as Qt has them."""

    def __init__(self, state="NotStarted", pin=None, accounts=None, rp="example.test",
                 failure=None):
        self.calls = []
        self.stateChanged = Signal()
        self._state, self._pin = state, pin
        self._accounts, self._rp, self._failure = accounts, rp, failure

    def state(self):
        return State(self._state)

    def pinRequest(self):
        return State(self._pin) if self._pin else None

    def userNames(self):
        return self._accounts

    def relyingPartyId(self):
        return self._rp

    def requestFailureReason(self):
        return State(self._failure) if self._failure else None

    def setPin(self, pin):
        self.calls.append(("setPin", pin))

    def setSelectedAccount(self, account):
        self.calls.append(("select", account))

    def cancel(self):
        self.calls.append(("cancel",))


class Val(unittest.TestCase):
    """_val must call Qt getters, because request.state is a method, not a property."""

    def setUp(self):
        self.m = load()

    def test_calls_a_method(self):
        self.assertEqual(self.m._val(Request(), "relyingPartyId"), "example.test")

    def test_returns_a_plain_value(self):
        self.assertEqual(self.m._val(type("O", (), {"x": 7})(), "x"), 7)

    def test_missing_member_gives_the_default(self):
        self.assertIs(self.m._val(Request(), "nope", "dflt"), "dflt")

    def test_a_getter_that_raises_gives_the_default(self):
        class Boom:
            def bad(self):
                raise RuntimeError("nope")
        self.assertIs(self.m._val(Boom(), "bad", "dflt"), "dflt")

    def test_state_name_prefers_name(self):
        self.assertEqual(self.m._state_name(State("CollectPin")), "CollectPin")

    def test_state_name_falls_back_to_str(self):
        self.assertEqual(self.m._state_name(42), "42")


class Dispatch(unittest.TestCase):
    """Each state must drive the request - or the browser appears to freeze."""

    def setUp(self):
        self.m = load()
        self.notices = []
        self.m._notice = self.notices.append

    def test_collect_pin_sets_the_pin(self):
        self.m._ask_pin = lambda reason: "123456"
        req = Request("CollectPin", pin="Challenge")
        self.m.handle(req)
        self.assertEqual(req.calls, [("setPin", "123456")])

    def test_collect_pin_cancels_when_dismissed(self):
        self.m._ask_pin = lambda reason: None
        req = Request("CollectPin", pin="Challenge")
        self.m.handle(req)
        self.assertEqual(req.calls, [("cancel",)])

    def test_select_account_chooses_one(self):
        self.m._ask_account = lambda names: "b@example.test"
        req = Request("SelectAccount", accounts=["a@example.test", "b@example.test"])
        self.m.handle(req)
        self.assertEqual(req.calls, [("select", "b@example.test")])

    def test_select_account_cancels_when_none(self):
        self.m._ask_account = lambda names: None
        req = Request("SelectAccount", accounts=["a@example.test"])
        self.m.handle(req)
        self.assertEqual(req.calls, [("cancel",)])

    def test_touch_state_only_notifies(self):
        req = Request("FinishTokenCollection", rp="accounts.example.test")
        self.m.handle(req)
        self.assertEqual(req.calls, [])
        self.assertIn("accounts.example.test", self.notices[0])

    def test_touch_state_falls_back_to_a_generic_name(self):
        req = Request("FinishTokenCollection", rp="")
        self.m.handle(req)
        self.assertIn("this site", self.notices[0])

    def test_failure_state_reports_the_reason(self):
        req = Request("RequestFailed", failure="Timeout")
        self.m.handle(req)
        self.assertIn("Timeout", self.notices[0])

    def test_an_uninteresting_state_does_nothing(self):
        req = Request("Completed")
        self.m.handle(req)
        self.assertEqual(req.calls, [])
        self.assertEqual(self.notices, [])

    def test_a_raising_handler_does_not_escape(self):
        def boom(reason):
            raise RuntimeError("no dialog")
        self.m._ask_pin = boom
        self.m.handle(Request("CollectPin", pin="Challenge"))   # must not raise


class Pins(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_prompt_text_per_reason(self):
        seen = []

        class FakeDialog:
            class EchoMode:
                Password = "pw"

            @staticmethod
            def getText(parent, title, label, mode):
                seen.append((title, label))
                return "1234", True

        import sys
        import types
        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QInputDialog = FakeDialog
        widgets.QLineEdit = FakeDialog
        pkg = types.ModuleType("PyQt6")
        pkg.QtWidgets = widgets
        sys.modules["PyQt6"] = pkg
        sys.modules["PyQt6.QtWidgets"] = widgets
        try:
            self.assertEqual(self.m._ask_pin(State("Set")), "1234")
            self.assertEqual(self.m._ask_pin(State("Change")), "1234")
            self.assertEqual(self.m._ask_pin(State("Challenge")), "1234")
            self.assertEqual(self.m._ask_pin(None), "1234")
        finally:
            sys.modules.pop("PyQt6", None)
            sys.modules.pop("PyQt6.QtWidgets", None)
        labels = [label for _, label in seen]
        self.assertIn("Set a PIN", labels[0])
        self.assertIn("CURRENT", labels[1])
        self.assertTrue(all("PIN" in label for label in labels))


class Accounts(unittest.TestCase):
    """The account chooser: one name needs no dialog, several do."""

    def setUp(self):
        self.m = load()
        self.seen = []
        # _ask_account imports QInputDialog up front, so the fake must exist even for the
        # paths that never show a dialog.
        self.with_dialog(("", True))

    def tearDown(self):
        import sys
        sys.modules.pop("PyQt6", None)
        sys.modules.pop("PyQt6.QtWidgets", None)

    def with_dialog(self, result):
        import sys
        import types
        self.seen = []
        seen = self.seen

        class FakeDialog:
            @staticmethod
            def getItem(parent, title, label, names, current, editable):
                seen.append((title, label, list(names), current, editable))
                return result

        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QInputDialog = FakeDialog
        pkg = types.ModuleType("PyQt6")
        pkg.QtWidgets = widgets
        sys.modules["PyQt6"] = pkg
        sys.modules["PyQt6.QtWidgets"] = widgets

    def test_no_names_means_no_choice(self):
        self.assertIsNone(self.m._ask_account([]))
        self.assertIsNone(self.m._ask_account(None))

    def test_a_single_name_is_taken_as_is(self):
        self.assertEqual(self.m._ask_account(["only@example.test"]), "only@example.test")

    def test_several_names_go_through_the_chooser(self):
        self.with_dialog(("b@example.test", True))
        self.assertEqual(self.m._ask_account(["a@example.test", "b@example.test"]),
                         "b@example.test")
        _, _, names, current, editable = self.seen[0]
        self.assertEqual(names, ["a@example.test", "b@example.test"])
        self.assertEqual(current, 0)                     # preselect the first
        self.assertFalse(editable)                       # never hand-edit an account

    def test_dismissing_the_chooser_returns_none(self):
        self.with_dialog(("a@example.test", False))
        self.assertIsNone(self.m._ask_account(["a@example.test", "b@example.test"]))

    def test_a_chooser_that_raises_returns_none(self):
        import sys
        import types

        class Boom:
            @staticmethod
            def getItem(*args, **kwargs):
                raise RuntimeError("no dialog")

        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QInputDialog = Boom
        pkg = types.ModuleType("PyQt6")
        pkg.QtWidgets = widgets
        sys.modules["PyQt6"] = pkg
        sys.modules["PyQt6.QtWidgets"] = widgets
        self.assertIsNone(self.m._ask_account(["a@example.test", "b@example.test"]))


class Install(unittest.TestCase):
    """install() must patch the classes, sweep what exists, and keep watching."""

    def setUp(self):
        import sys
        import types
        self.sys, self.types = sys, types
        self.saved = {k: sys.modules.get(k) for k in
                      ("PyQt6", "PyQt6.QtCore", "PyQt6.QtWidgets", "PyQt6.QtWebEngineCore",
                       "qutebrowser", "qutebrowser.utils",
                       "qutebrowser.browser", "qutebrowser.browser.webengine",
                       "qutebrowser.browser.webengine.webview")}
        self.m = load()

        class FakePage:
            def __init__(self, *args, **kwargs):
                self.webAuthUxRequested = Signal()

        class FakeView:
            def __init__(self, *args, **kwargs):
                self._page = FakePage()

            def page(self):
                return self._page

        self.FakePage, self.FakeView = FakePage, FakeView
        self.timers = []
        test = self

        class QTimer:
            def __init__(self):
                self.timeout = Signal()
                self.started = None
                test.timers.append(self)

            def start(self, ms):
                self.started = ms

            @staticmethod
            def singleShot(ms, fn):
                test.single_shot = ms

        class QApplication:
            widgets = []

            @staticmethod
            def allWidgets():
                return list(QApplication.widgets)

        core = types.ModuleType("PyQt6.QtCore")
        core.QTimer = QTimer
        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QApplication = QApplication
        webcore = types.ModuleType("PyQt6.QtWebEngineCore")
        webcore.QWebEnginePage = FakePage
        pkg = types.ModuleType("PyQt6")
        pkg.QtCore, pkg.QtWidgets, pkg.QtWebEngineCore = core, widgets, webcore

        webview = types.ModuleType("qutebrowser.browser.webengine.webview")
        webview.WebEnginePage = FakePage
        webview.WebEngineView = FakeView

        for name, mod in (("PyQt6", pkg), ("PyQt6.QtCore", core), ("PyQt6.QtWidgets", widgets),
                          ("PyQt6.QtWebEngineCore", webcore),
                          ("qutebrowser", types.ModuleType("qutebrowser")),
                          ("qutebrowser.utils", types.ModuleType("qutebrowser.utils")),
                          ("qutebrowser.browser", types.ModuleType("qutebrowser.browser")),
                          ("qutebrowser.browser.webengine",
                           types.ModuleType("qutebrowser.browser.webengine")),
                          ("qutebrowser.browser.webengine.webview", webview)):
            sys.modules[name] = mod
        self.webview, self.QApplication, self.FakePage = webview, QApplication, FakePage

    def tearDown(self):
        for name, module in self.saved.items():
            if module is None:
                self.sys.modules.pop(name, None)
            else:
                self.sys.modules[name] = module

    def test_install_patches_both_classes(self):
        self.m.install()
        self.assertTrue(getattr(self.webview.WebEnginePage, "_omarchy_webauthn_init", False))
        self.assertTrue(getattr(self.webview.WebEngineView, "_omarchy_webauthn_init", False))

    def test_a_page_created_afterwards_is_attached(self):
        self.m.install()
        page = self.FakePage()
        self.assertEqual(len(page.webAuthUxRequested.slots), 1)

    def test_a_view_created_afterwards_attaches_its_page(self):
        self.m.install()
        view = self.webview.WebEngineView()
        self.assertEqual(len(view.page().webAuthUxRequested.slots), 1)

    def test_the_sweep_timer_runs_every_two_seconds(self):
        self.m.install()
        self.assertEqual([t.started for t in self.timers], [2000])

    def test_an_immediate_sweep_is_scheduled_and_run(self):
        self.m.install()
        self.assertEqual(getattr(self, "single_shot", None), 0)

    def test_install_twice_neither_repaches_nor_restarts(self):
        self.m.install()
        first = self.webview.WebEnginePage.__init__
        self.m.install()
        self.assertIs(self.webview.WebEnginePage.__init__, first)
        self.assertEqual(len(self.timers), 1)          # the second call returns before adding one

    def test_sweep_attaches_pages_found_in_the_widget_tree(self):
        page = self.FakePage()
        view = self.types.SimpleNamespace(page=lambda: page)
        self.QApplication.widgets = [view, page, object()]
        self.m.sweep()
        self.assertEqual(len(page.webAuthUxRequested.slots), 1)

    def test_sweep_tolerates_widgets_that_raise(self):
        class Hostile:
            def page(self):
                raise RuntimeError("no page here")
        self.QApplication.widgets = [Hostile()]
        self.m.sweep()                                   # must not raise

    def test_attach_connects_only_once(self):
        page = self.FakePage()
        self.m.attach(page)
        self.m.attach(page)
        self.assertEqual(len(page.webAuthUxRequested.slots), 1)

    def test_attach_swallows_a_page_without_the_signal(self):
        self.m.attach(object())                          # must not raise


if __name__ == "__main__":
    unittest.main()

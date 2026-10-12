"""Unit tests for config/omarchy_webauthn.py - the WebAuthn UX handler.

qutebrowser never connects QWebEnginePage.webAuthUxRequested, so a passkey ceremony waits forever:
no dialog, no result. This module answers the request. The tests drive the state machine with
fakes - no Qt, no browser, no security key - and assert exactly what the handler does with each
state, because that is the difference between a prompt appearing and the ceremony hanging.

The full state machine is covered, not just the happy path: the PIN error/min-length/attempts
surfacing, the failure-reason mapping, the retry offered on a recoverable failure, and the
non-modal passkey chooser (its key map, its cursor stepping and where it is placed).
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


class PinRequest:
    """Qt's QWebEngineWebAuthPinRequest: reason, error, minPinLength, remainingAttempts."""

    def __init__(self, reason="Challenge", error="NoError", min_pin=0, remaining=-1):
        self.reason = State(reason)
        self.error = State(error)
        self.minPinLength = min_pin
        self.remainingAttempts = remaining


class Request:
    """A stand-in for QWebEngineWebAuthUxRequest: every getter is a METHOD, as Qt has them."""

    def __init__(self, state="NotStarted", pin=None, accounts=None, rp="example.test",
                 failure=None, error=None, min_pin=0, remaining=-1):
        self.calls = []
        self.stateChanged = Signal()
        self._state, self._pin = state, pin
        self._accounts, self._rp, self._failure = accounts, rp, failure
        self._pin_request = PinRequest(pin or "Challenge", error or "NoError", min_pin, remaining)

    def state(self):
        return State(self._state)

    def pinRequest(self):
        return self._pin_request

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

    def retry(self):
        self.calls.append(("retry",))


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


class Name(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_uses_the_name(self):
        self.assertEqual(self.m._name(State("WrongPin"), "NoError"), "WrongPin")

    def test_missing_name_gives_the_default(self):
        self.assertEqual(self.m._name(object(), "NoError"), "NoError")

    def test_none_gives_the_default(self):
        self.assertEqual(self.m._name(None, "Challenge"), "Challenge")


class Keys(unittest.TestCase):
    """The suggestion list's key map."""

    def setUp(self):
        self.m = load()

    def test_vim_and_arrow_keys_move(self):
        self.assertEqual(self.m.key_action("Down"), "down")
        self.assertEqual(self.m.key_action("j"), "down")
        self.assertEqual(self.m.key_action("J"), "down")
        self.assertEqual(self.m.key_action("Up"), "up")
        self.assertEqual(self.m.key_action("k"), "up")
        self.assertEqual(self.m.key_action("K"), "up")

    def test_enter_accepts_and_escape_dismisses(self):
        self.assertEqual(self.m.key_action("Return"), "accept")
        self.assertEqual(self.m.key_action("Enter"), "accept")
        self.assertEqual(self.m.key_action("Escape"), "dismiss")

    def test_an_unrelated_key_does_nothing(self):
        self.assertIsNone(self.m.key_action("q"))
        self.assertIsNone(self.m.key_action(""))


class Step(unittest.TestCase):
    """The cursor steps by one and clamps at both ends."""

    def setUp(self):
        self.m = load()

    def test_down(self):
        self.assertEqual(self.m.step_index(0, 3, 1), 1)

    def test_up_at_the_top_stays(self):
        self.assertEqual(self.m.step_index(0, 3, -1), 0)

    def test_down_at_the_bottom_stays(self):
        self.assertEqual(self.m.step_index(2, 3, 1), 2)

    def test_a_bigger_jump(self):
        self.assertEqual(self.m.step_index(1, 5, 2), 3)

    def test_an_empty_list_is_zero(self):
        self.assertEqual(self.m.step_index(0, 0, 1), 0)


class Place(unittest.TestCase):
    """The popup sits just below its anchor and never leaves the viewport."""

    def setUp(self):
        self.m = load()

    def test_below_the_anchor(self):
        self.assertEqual(self.m.place_popup((10, 20, 0, 5), (0, 0, 800, 600), (200, 100)),
                         (10, 27))

    def test_clamped_to_the_left_edge(self):
        self.assertEqual(self.m.place_popup((-50, 20, 0, 5), (0, 0, 800, 600), (200, 100)),
                         (0, 27))

    def test_clamped_to_the_right_edge(self):
        self.assertEqual(self.m.place_popup((700, 20, 0, 5), (0, 0, 800, 600), (200, 100)),
                         (600, 27))

    def test_clamped_to_the_bottom_edge(self):
        self.assertEqual(self.m.place_popup((10, 590, 0, 5), (0, 0, 800, 600), (200, 100)),
                         (10, 500))


class Dispatch(unittest.TestCase):
    """Each state must drive the request - or the browser appears to freeze."""

    def setUp(self):
        self.m = load()
        self.notices = []
        self.m._notice = self.notices.append
        self.m._ask_retry = lambda text: False
        # A chooser that answers immediately, standing in for the popup the real one shows.
        self.choose = lambda page, names, callback: callback(names[0] if names else None)

    def drive(self, req, choose=None):
        self.m.handle(None, req, choose=choose or self.choose)

    def test_collect_pin_sets_the_pin(self):
        self.m._ask_pin = lambda pin_request: "123456"
        req = Request("CollectPin", pin="Challenge")
        self.drive(req)
        self.assertEqual(req.calls, [("setPin", "123456")])

    def test_collect_pin_cancels_when_dismissed(self):
        self.m._ask_pin = lambda pin_request: None
        req = Request("CollectPin", pin="Challenge")
        self.drive(req)
        self.assertEqual(req.calls, [("cancel",)])

    def test_select_account_chooses_one(self):
        req = Request("SelectAccount", accounts=["a@example.test", "b@example.test"])
        self.drive(req, choose=lambda page, names, cb: cb("b@example.test"))
        self.assertEqual(req.calls, [("select", "b@example.test")])

    def test_select_account_cancels_when_none(self):
        req = Request("SelectAccount", accounts=["a@example.test"])
        self.drive(req, choose=lambda page, names, cb: cb(None))
        self.assertEqual(req.calls, [("cancel",)])

    def test_select_account_passes_the_names_through(self):
        seen = {}
        req = Request("SelectAccount", accounts=["a@example.test", "b@example.test"])
        self.drive(req, choose=lambda page, names, cb: seen.setdefault("names", names))
        self.assertEqual(seen["names"], ["a@example.test", "b@example.test"])

    def test_touch_state_only_notifies(self):
        req = Request("FinishTokenCollection", rp="accounts.example.test")
        self.drive(req)
        self.assertEqual(req.calls, [])
        self.assertIn("accounts.example.test", self.notices[0])

    def test_touch_state_falls_back_to_a_generic_name(self):
        req = Request("FinishTokenCollection", rp="")
        self.drive(req)
        self.assertIn("this site", self.notices[0])

    def test_failure_state_reports_the_human_reason(self):
        req = Request("RequestFailed", failure="Timeout")
        self.drive(req)
        self.assertIn("timed out", self.notices[0])
        self.assertEqual(req.calls, [])                       # retry declined -> no call

    def test_a_recoverable_failure_retries_when_confirmed(self):
        self.m._ask_retry = lambda text: True
        req = Request("RequestFailed", failure="Timeout")
        self.drive(req)
        self.assertEqual(req.calls, [("retry",)])

    def test_a_non_recoverable_failure_never_retries(self):
        self.m._ask_retry = lambda text: True                  # even if the user says yes
        req = Request("RequestFailed", failure="HardPinBlock")
        self.drive(req)
        self.assertEqual(req.calls, [])

    def test_completed_is_announced(self):
        self.drive(Request("Completed"))
        self.assertIn("Signed in", self.notices[0])

    def test_cancelled_is_announced(self):
        self.drive(Request("Cancelled"))
        self.assertIn("cancelled", self.notices[0])

    def test_not_started_is_silent(self):
        self.drive(Request("NotStarted"))
        self.assertEqual(self.notices, [])

    def test_a_raising_handler_does_not_escape(self):
        def boom(reason):
            raise RuntimeError("no dialog")
        self.m._ask_pin = boom
        self.drive(Request("CollectPin", pin="Challenge"))     # must not raise


class Chooser(unittest.TestCase):
    """_choose_account: a single key is taken as-is, several go through the popup."""

    def setUp(self):
        self.m = load()
        # Pin the anchor lookup: these tests must not touch real Qt.
        self.m._view_for = lambda page: None

    def test_no_names_gives_none(self):
        got = []
        self.m._choose_account(None, [], got.append)
        self.assertEqual(got, [None])

    def test_none_gives_none(self):
        got = []
        self.m._choose_account(None, None, got.append)
        self.assertEqual(got, [None])

    def test_a_single_name_is_taken_as_is(self):
        got = []
        self.m._choose_account(None, ["only@example.test"], got.append)
        self.assertEqual(got, ["only@example.test"])

    def test_several_names_go_through_the_popup(self):
        seen = {}

        class FakePopup:
            def __init__(self, names, callback):
                seen["names"] = names
                self.size = (300, 120)
                self.callback = callback

            def show_at(self, anchor, viewport):
                seen["anchor"] = anchor
                seen["viewport"] = viewport
                self.callback("b@example.test")

        self.m._AccountPopup = FakePopup
        got = []
        self.m._choose_account(None, ["a@example.test", "b@example.test"], got.append)
        self.assertEqual(got, ["b@example.test"])
        self.assertEqual(seen["names"], ["a@example.test", "b@example.test"])
        self.assertEqual(seen["anchor"], (0, 0, 0, 0))        # no view -> origin fallback

    def test_a_popup_that_raises_gives_none(self):
        class Boom:
            def __init__(self, *args):
                raise RuntimeError("no widget")

        self.m._AccountPopup = Boom
        got = []
        self.m._choose_account(None, ["a@example.test", "b@example.test"], got.append)
        self.assertEqual(got, [None])


class PinMessage(unittest.TestCase):
    """The PIN label must explain the reason, the last error, the minimum and the attempts left."""

    def setUp(self):
        self.m = load()

    def msg(self, **kwargs):
        return self.m._pin_message(PinRequest(**kwargs))

    def test_default_is_the_challenge_prompt(self):
        self.assertEqual(self.msg(), "Enter your security key PIN")

    def test_none_request_is_the_challenge_prompt(self):
        self.assertEqual(self.m._pin_message(None), "Enter your security key PIN")

    def test_set_prompt(self):
        self.assertIn("Set a PIN", self.msg(reason="Set"))

    def test_change_prompt(self):
        self.assertIn("CURRENT", self.msg(reason="Change"))

    def test_wrong_pin_error(self):
        self.assertIn("wrong", self.msg(error="WrongPin"))

    def test_too_short_error(self):
        self.assertIn("too short", self.msg(error="TooShort"))

    def test_invalid_characters_error(self):
        self.assertIn("invalid characters", self.msg(error="InvalidCharacters"))

    def test_same_as_current_error(self):
        self.assertIn("differ", self.msg(error="SameAsCurrentPin"))

    def test_uv_locked_error(self):
        self.assertIn("locked", self.msg(error="InternalUvLocked"))

    def test_no_error_adds_nothing(self):
        self.assertEqual(self.msg(error="NoError"), self.msg())

    def test_min_length_shown_on_set(self):
        self.assertIn("at least 8", self.msg(reason="Set", min_pin=8))

    def test_min_length_hidden_on_challenge(self):
        self.assertNotIn("at least", self.msg(reason="Challenge", min_pin=8))

    def test_zero_min_length_is_hidden(self):
        self.assertNotIn("at least", self.msg(reason="Set", min_pin=0))

    def test_missing_min_length_attribute_is_hidden(self):
        # A Set request whose pinRequest carries no minPinLength at all: the default must be
        # treated as "no minimum", never as 1.
        class Bare:
            reason = State("Set")
            error = State("NoError")
        self.assertNotIn("at least", self.m._pin_message(Bare()))

    def test_zero_attempts_warns(self):
        self.assertIn("0 attempt", self.msg(remaining=0))

    def test_one_attempt_warns(self):
        self.assertIn("1 attempt", self.msg(remaining=1))

    def test_two_attempts_warns(self):
        self.assertIn("2 attempt", self.msg(remaining=2))

    def test_three_attempts_is_quiet(self):
        self.assertNotIn("attempt", self.msg(remaining=3))

    def test_negative_attempts_is_quiet(self):
        self.assertNotIn("attempt", self.msg(remaining=-1))

    def test_non_integer_attempts_is_quiet(self):
        self.assertNotIn("attempt", self.msg(remaining="x"))


class Failure(unittest.TestCase):
    """Failure reasons become sentences, and only the recoverable ones are retried."""

    def setUp(self):
        self.m = load()

    def test_known_reason(self):
        self.assertIn("timed out", self.m._failure_text(State("Timeout")))

    def test_blocked_pin_reason(self):
        self.assertIn("blocked", self.m._failure_text(State("HardPinBlock")))

    def test_an_unknown_reason_names_itself(self):
        self.assertIn("MadeUp", self.m._failure_text(State("MadeUp")))

    def test_a_missing_reason_says_unknown(self):
        self.assertIn("unknown", self.m._failure_text(None))

    def test_timeout_is_retryable(self):
        self.assertTrue(self.m._retryable(State("Timeout")))

    def test_removal_is_retryable(self):
        self.assertTrue(self.m._retryable(State("AuthenticatorRemovedDuringPinEntry")))

    def test_a_blocked_pin_is_not_retryable(self):
        self.assertFalse(self.m._retryable(State("HardPinBlock")))

    def test_a_missing_reason_is_not_retryable(self):
        self.assertFalse(self.m._retryable(None))


class Pins(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def with_pin_dialog(self, result):
        import sys
        import types
        seen = []

        class FakeDialog:
            class EchoMode:
                Password = "pw"

            @staticmethod
            def getText(parent, title, label, mode):
                seen.append((title, label))
                return result

        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QInputDialog = FakeDialog
        widgets.QLineEdit = FakeDialog
        pkg = types.ModuleType("PyQt6")
        pkg.QtWidgets = widgets
        sys.modules["PyQt6"] = pkg
        sys.modules["PyQt6.QtWidgets"] = widgets
        return seen

    def tearDown(self):
        import sys
        sys.modules.pop("PyQt6", None)
        sys.modules.pop("PyQt6.QtWidgets", None)

    def test_prompt_text_per_reason(self):
        seen = self.with_pin_dialog(("1234", True))
        self.assertEqual(self.m._ask_pin(PinRequest("Set")), "1234")
        self.assertEqual(self.m._ask_pin(PinRequest("Change")), "1234")
        self.assertEqual(self.m._ask_pin(PinRequest("Challenge")), "1234")
        self.assertEqual(self.m._ask_pin(None), "1234")
        labels = [label for _, label in seen]
        self.assertIn("Set a PIN", labels[0])
        self.assertIn("CURRENT", labels[1])
        self.assertTrue(all("PIN" in label for label in labels))

    def test_cancelling_the_pin_prompt_returns_none(self):
        self.with_pin_dialog(("", False))
        self.assertIsNone(self.m._ask_pin(PinRequest("Challenge")))


class Retry(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def with_message_box(self, answer=None, raises=False):
        import sys
        import types

        class FakeBox:
            class StandardButton:
                Yes = "yes"

            @staticmethod
            def question(parent, title, text):
                if raises:
                    raise RuntimeError("no dialog")
                return answer

        widgets = types.ModuleType("PyQt6.QtWidgets")
        widgets.QMessageBox = FakeBox
        pkg = types.ModuleType("PyQt6")
        pkg.QtWidgets = widgets
        sys.modules["PyQt6"] = pkg
        sys.modules["PyQt6.QtWidgets"] = widgets

    def tearDown(self):
        import sys
        sys.modules.pop("PyQt6", None)
        sys.modules.pop("PyQt6.QtWidgets", None)

    def test_yes_means_retry(self):
        self.with_message_box("yes")
        self.assertTrue(self.m._ask_retry("timed out"))

    def test_no_means_no_retry(self):
        self.with_message_box("no")
        self.assertFalse(self.m._ask_retry("timed out"))

    def test_a_dialog_that_raises_means_no_retry(self):
        self.with_message_box(raises=True)
        self.assertFalse(self.m._ask_retry("timed out"))


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


def _fake_qt():
    """Install the smallest PyQt6 surface the popup and _view_for touch, and return it."""
    import sys
    import types

    class Widget:
        def __init__(self, *args, **kwargs):
            self.pos = None
            self.shown = False
            self.closed = False
            self.ss = None

        def setFixedSize(self, w, h):
            self.fixed = (w, h)

        def setGeometry(self, *args):
            pass

        def move(self, x, y):
            self.pos = (x, y)

        def show(self):
            self.shown = True

        def raise_(self):
            pass

        def activateWindow(self):
            pass

        def close(self):
            self.closed = True

        def setStyleSheet(self, sheet):
            self.ss = sheet

        def isModal(self):
            return False

    class ListWidget:
        def __init__(self, parent):
            self.items = []
            self.row = 0
            self.itemClicked = Signal()
            self.itemActivated = Signal()

        def setFocusPolicy(self, *args):
            pass

        def setGeometry(self, *args):
            pass

        def count(self):
            return len(self.items)

        def setCurrentRow(self, row):
            self.row = row

        def currentRow(self):
            return self.row

        def setFocus(self):
            pass

    class ListWidgetItem:
        def __init__(self, text, parent):
            parent.items.append(text)

    class QApplication:
        widgets = []

        @staticmethod
        def allWidgets():
            return list(QApplication.widgets)

    qt_core = types.ModuleType("PyQt6.QtCore")
    qt_core.Qt = types.SimpleNamespace(
        WindowType=types.SimpleNamespace(FramelessWindowHint=1, Tool=2, WindowStaysOnTopHint=4),
        FocusPolicy=types.SimpleNamespace(StrongFocus=1),
        Key=types.SimpleNamespace(Key_Down=1, Key_Up=2, Key_Return=3, Key_Enter=4, Key_Escape=5))
    qt_widgets = types.ModuleType("PyQt6.QtWidgets")
    qt_widgets.QWidget = Widget
    qt_widgets.QListWidget = ListWidget
    qt_widgets.QListWidgetItem = ListWidgetItem
    qt_widgets.QApplication = QApplication
    pkg = types.ModuleType("PyQt6")
    pkg.QtCore = qt_core
    pkg.QtWidgets = qt_widgets
    return {"PyQt6": pkg, "PyQt6.QtCore": qt_core, "PyQt6.QtWidgets": qt_widgets}


class QtStubCase(unittest.TestCase):
    """Base: install the fake PyQt6 for the duration of one test and restore it after."""

    KEYS = ("PyQt6", "PyQt6.QtCore", "PyQt6.QtWidgets")

    def setUp(self):
        import sys
        self.m = load()
        self._saved = {k: sys.modules.get(k) for k in self.KEYS}
        for name, mod in _fake_qt().items():
            sys.modules[name] = mod

    def tearDown(self):
        import sys
        for name, mod in self._saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


class KeyEvent:
    def __init__(self, text="", key=0):
        self._text = text
        self._key = key

    def text(self):
        return self._text

    def key(self):
        return self._key


class Popup(QtStubCase):
    """The real suggestion-list widget, driven against a fake Qt."""

    def setUp(self):
        super().setUp()
        self.m._colors = lambda: {}

    def popup(self, names):
        self.got = []
        return self.m._AccountPopup(list(names), self.got.append)

    def test_it_lists_every_name_and_is_not_modal(self):
        popup = self.popup(["a", "b", "c"])
        self.assertEqual(popup._list.count(), 3)
        self.assertFalse(popup._widget.isModal())
        self.assertEqual(popup.size, (300, 3 * 28 + 8))

    def test_the_height_is_capped(self):
        popup = self.popup(["n%d" % i for i in range(20)])
        self.assertEqual(popup.size[1], 240)

    def test_the_selection_starts_on_the_first(self):
        popup = self.popup(["a", "b"])
        self.assertEqual(popup._list.currentRow(), 0)

    def test_down_and_up_move_the_selection(self):
        popup = self.popup(["a", "b", "c"])
        popup._move(1)
        self.assertEqual(popup._list.currentRow(), 1)
        popup._move(-1)
        self.assertEqual(popup._list.currentRow(), 0)

    def test_vim_keys_move_the_selection(self):
        popup = self.popup(["a", "b", "c"])
        popup._on_key(KeyEvent("j"))
        self.assertEqual(popup._list.currentRow(), 1)
        popup._on_key(KeyEvent("k"))
        self.assertEqual(popup._list.currentRow(), 0)

    def test_enter_accepts_the_selection(self):
        popup = self.popup(["a", "b", "c"])
        popup._on_key(KeyEvent("j"))
        popup._on_key(KeyEvent(text="", key=3))          # Return
        self.assertEqual(self.got, ["b"])

    def test_escape_dismisses_with_none(self):
        popup = self.popup(["a", "b"])
        popup._on_key(KeyEvent(text="", key=5))          # Escape
        self.assertEqual(self.got, [None])

    def test_an_unrelated_key_is_ignored(self):
        popup = self.popup(["a", "b"])
        popup._on_key(KeyEvent("q"))
        self.assertEqual(self.got, [])
        self.assertFalse(popup._widget.closed)

    def test_accepting_the_first_row_picks_the_first_name(self):
        popup = self.popup(["only", "second"])
        popup._accept_current()
        self.assertEqual(self.got, ["only"])

    def test_an_out_of_range_row_picks_nothing(self):
        popup = self.popup(["a", "b"])
        popup._list.row = 2                              # == len(names)
        popup._accept_current()
        self.assertEqual(self.got, [None])

    def test_a_choice_is_delivered_once(self):
        popup = self.popup(["a", "b"])
        popup._accept_current()
        popup._dismiss()
        self.assertEqual(len(self.got), 1)

    def test_clicking_a_row_accepts_it(self):
        popup = self.popup(["a", "b"])
        popup._list.setCurrentRow(1)
        popup._accept_current("clicked")                 # the signal passes the item
        self.assertEqual(self.got, ["b"])

    def test_show_places_it_at_the_computed_spot(self):
        popup = self.popup(["a", "b"])
        popup.show_at((10, 20, 0, 5), (0, 0, 800, 600))
        self.assertEqual(popup._widget.pos, self.m.place_popup((10, 20, 0, 5), (0, 0, 800, 600),
                                                               popup.size))
        self.assertTrue(popup._widget.shown)

    def test_the_popup_is_styled_from_the_live_theme(self):
        self.m._colors = lambda: {"bg_dark": "#101010", "fg": "#eeeeee", "accent": "#ff00ff"}
        popup = self.m._AccountPopup(["a", "b"], [].append)
        self.assertIn("#101010", popup._widget.ss)
        self.assertIn("#eeeeee", popup._widget.ss)
        self.assertIn("#ff00ff", popup._widget.ss)

    def test_a_theme_without_colours_falls_back_to_defaults(self):
        popup = self.popup(["a", "b"])
        self.assertIn("#1e1e2e", popup._widget.ss)

    def test_losing_the_window_cancels(self):
        popup = self.popup(["a", "b"])
        popup._on_close(None)
        self.assertEqual(self.got, [None])


class ViewFor(QtStubCase):
    """_view_for finds the widget showing a page, and nothing when there is none."""

    def setUp(self):
        super().setUp()
        import sys
        self.QApplication = sys.modules["PyQt6.QtWidgets"].QApplication

    def widget(self, page):
        test = self

        class W:
            def __init__(self):
                self._page = page

            def page(inner):
                return inner._page

        _ = test
        return W()

    def test_finds_the_view_showing_the_page(self):
        page = object()
        good = self.widget(page)
        self.QApplication.widgets = [self.widget(object()), good]
        self.assertIs(self.m._view_for(page), good)

    def test_none_when_no_view_shows_it(self):
        self.QApplication.widgets = [self.widget(object()), object()]
        self.assertIsNone(self.m._view_for(object()))


if __name__ == "__main__":
    unittest.main()

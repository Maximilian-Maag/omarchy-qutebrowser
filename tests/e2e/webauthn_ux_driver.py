#!/usr/bin/env python3
"""End-to-end: the REAL WebAuthn UX handler driven against the REAL QtWebEngine, offscreen.

Two things this proves that the unit tests cannot:

  1. ``attach()`` connects the module to a real ``QWebEnginePage`` — the very signal
     (``webAuthUxRequested``) qutebrowser never wires, which is why a ceremony hangs;
  2. the ENGINE answers the capability question the way the patched build does
     (``PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()``), because an engine
     that answers ``false`` is the whole reason a sign-in page never starts a ceremony.

It isolates every XDG dir (sharing them with a live browser makes QtWebEngine abort) and runs
with ``QT_QPA_PLATFORM=offscreen``, so no display is needed. It prints ``E2E <KEY>=<value>`` lines
that tests/e2e/test_webauthn_ux_e2e.sh asserts on.
"""
import importlib.util
import os
import pathlib
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]

_TMP = tempfile.mkdtemp(prefix="webauthn-e2e-")
for _var, _sub in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                   ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
    os.environ[_var] = os.path.join(_TMP, _sub)
os.environ["XDG_RUNTIME_DIR"] = os.path.join(_TMP, "run")
os.makedirs(os.environ["XDG_RUNTIME_DIR"], mode=0o700, exist_ok=True)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--no-sandbox --disable-gpu --disable-dev-shm-usage "
                      "--disable-background-timer-throttling "
                      "--disable-backgrounding-occluded-windows "
                      "--disable-renderer-backgrounding "
                      "--disable-features=CalculateNativeWinOcclusion,NetworkService")

from PyQt6.QtCore import QEventLoop, QTimer, QUrl          # noqa: E402
from PyQt6.QtWidgets import QApplication                   # noqa: E402
from PyQt6.QtWebEngineCore import QWebEnginePage           # noqa: E402

spec = importlib.util.spec_from_file_location("omarchy_webauthn",
                                              REPO / "config" / "omarchy_webauthn.py")
wa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa)

app = QApplication(["webauthn-e2e"])
results = {}


def wait_for(predicate, timeout_ms=8000):
    """Spin the real event loop until predicate() or the timeout."""
    loop = QEventLoop()
    timer = QTimer()
    timer.setInterval(50)
    waited = {"ms": 0}

    def tick():
        waited["ms"] += 50
        if predicate() or waited["ms"] >= timeout_ms:
            timer.stop()
            loop.quit()

    timer.timeout.connect(tick)
    timer.start()
    loop.exec()


# ── 1. attach to a real QWebEnginePage ────────────────────────────────────────
page = QWebEnginePage()
wa.attach(page)
results["ATTACH"] = "ok" if getattr(page, "_omarchy_webauthn", False) else "FAIL"

# ── 2. drive the REAL handler through the whole state machine ─────────────────
class Sig:
    def __init__(self):
        self.slots = []

    def connect(self, slot):
        self.slots.append(slot)

    def emit(self, value):
        for slot in list(self.slots):
            slot(value)


class St:
    def __init__(self, name):
        self.name = name


class Req:
    """Qt's request shape; the module under test is the real one, on the real event loop."""

    def __init__(self):
        self.calls = []
        self.stateChanged = Sig()
        self._s = "NotStarted"

    def state(self):
        return St(self._s)

    def pinRequest(self):
        return type("P", (), {"reason": St("Challenge"), "error": St("WrongPin"),
                              "minPinLength": 6, "remainingAttempts": 1})()

    def userNames(self):
        return ["a@example.test", "b@example.test"]

    def relyingPartyId(self):
        return "example.test"

    def requestFailureReason(self):
        return None

    def setPin(self, pin):
        self.calls.append(("setPin", pin))

    def setSelectedAccount(self, account):
        self.calls.append(("select", account))

    def cancel(self):
        self.calls.append(("cancel",))

    def retry(self):
        self.calls.append(("retry",))

    def fire(self, state):
        self._s = state
        self.stateChanged.emit(St(state))


notices = []
wa._notice = notices.append
wa._ask_pin = lambda pin_request: "123456"
wa._ask_retry = lambda text: True
choose = lambda page, names, callback: callback(names[1])    # stands in for the real popup

req = Req()
wa.handle(None, req, choose=choose)  # NotStarted -> silent
req.fire("CollectPin")
req.fire("SelectAccount")
req.fire("FinishTokenCollection")
req.fire("RequestFailed")            # no reason -> not retryable
req.fire("Completed")
results["DRIVE"] = "ok" if (("setPin", "123456") in req.calls
                            and ("select", "b@example.test") in req.calls) else "FAIL"
results["TOUCH"] = "ok" if any("Touch your security key" in n for n in notices) else "FAIL"
results["DONE"] = "ok" if any("Signed in" in n for n in notices) else "FAIL"

pin_msg = wa._pin_message(req.pinRequest())
results["PINMSG"] = "ok" if ("wrong" in pin_msg.lower() and "1 attempt" in pin_msg
                             and "at least" not in pin_msg) else "FAIL"

# ── 2b. the REAL suggestion popup: non-modal and keyboard-driven ──────────────
picked = []
popup = wa._AccountPopup(["a@example.test", "b@example.test", "c@example.test"], picked.append)
results["POPUP_MODAL"] = "ok" if not popup._widget.isModal() else "FAIL"
results["POPUP_ITEMS"] = "ok" if popup._list.count() == 3 else "FAIL"
popup._move(1)
results["POPUP_STEP"] = "ok" if popup._list.currentRow() == 1 else "FAIL"
popup._move(10)                      # clamps at the bottom
results["POPUP_CLAMP"] = "ok" if popup._list.currentRow() == 2 else "FAIL"
popup._move(-1)
popup._accept_current()
results["POPUP_PICK"] = "ok" if picked == ["b@example.test"] else "FAIL"

# ── 3. the engine's capability answer, from the real page ─────────────────────
state = {"loaded": False, "uvpa": "pending"}


def on_load(_ok):
    state["loaded"] = True
    page.runJavaScript(
        "window.__uvpa='pending';"
        "if (typeof PublicKeyCredential!=='undefined' && "
        "    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {"
        "  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()"
        "    .then(function(v){ window.__uvpa = String(v); });"
        "} else { window.__uvpa = 'nofn'; }")


def read_uvpa():
    got = {"v": None}
    page.runJavaScript("window.__uvpa", lambda v: got.__setitem__("v", v))
    wait_for(lambda: got["v"] is not None, 2000)
    return got["v"]


page.loadFinished.connect(on_load)
page.setHtml("<!doctype html><body>capability probe</body>", QUrl("https://example.test/"))
wait_for(lambda: state["loaded"])
deadline = {"ms": 0}
while deadline["ms"] < 8000:
    value = read_uvpa()
    if value is not None and value != "pending":
        state["uvpa"] = value
        break
    deadline["ms"] += 200
results["UVPA"] = str(state["uvpa"])

# ── report ────────────────────────────────────────────────────────────────────
for key in ("ATTACH", "DRIVE", "TOUCH", "DONE", "PINMSG", "POPUP_MODAL", "POPUP_ITEMS",
            "POPUP_STEP", "POPUP_CLAMP", "POPUP_PICK", "UVPA"):
    print("E2E %s=%s" % (key, results[key]))
sys.exit(0)

"""WebAuthn UX handling for qutebrowser.

QtWebEngine hands the WebAuthn user experience to the embedding application: it emits
``QWebEnginePage.webAuthUxRequested()`` and the application is expected to drive the request's
state machine (account choice, PIN entry, "touch your token"). qutebrowser never connects that
signal, so every public-key credential request — a security key tap, a PIN, an account choice —
waits forever: no prompt, no dialog, no result. The engine has already found the token and is
waiting to be told what to show the user.

This module supplies what is missing. It attaches a handler to every page, present and future, and
drives Qt's request states with Qt dialogs and qutebrowser's message bar. Nothing about the browser
is hidden and no page JavaScript is touched, so a site cannot tell it is there — it is simply what
the engine expects a browser to do. That is also why it is the right fix for sign-in pages that
refuse a browser whose WebAuthn API has been overridden: there is no override to detect.

It drives the *whole* state machine, not just the happy path. Qt's PIN request carries the reason,
the last error, the minimum length and the number of remaining attempts; the failure carries one of
thirteen reasons. Ignoring those is how a ceremony dies with a spinner: a too-short PIN loops
silently, a wrong PIN is re-asked with no explanation, and a transient failure (a key briefly
unplugged) ends the sign-in instead of offering to retry. Each of those is handled here.

When the token holds several passkeys, the chooser is a **non-modal suggestion list** anchored to
the page (see ``_AccountPopup``) rather than a blocking dialog: a conditional ("sign in with a
passkey") request fires as soon as the page loads, and a modal that jams the UI at that moment is
exactly the wrong shape. The list is keyboard-driven (j/k or arrows, Enter, Escape), reads the
applied Omarchy theme, and never blocks the page.

Everything is wrapped defensively: a browser must never fail to start because of this module.
"""
try:                                                  # pragma: no cover - exercised in the browser
    from qutebrowser.utils import log
except Exception:                                    # no browser around (unit tests, tooling)

    class _NullLogger:
        """Swallow log calls so the module imports anywhere."""

        def debug(self, *args, **kwargs):
            pass

        info = warning = error = exception = debug

    class _NullLog:
        webview = _NullLogger()

    log = _NullLog()


# Qt's QWebEngineWebAuthUxRequest::RequestFailureReason -> what to tell the user. The raw enum
# name ("AuthenticatorRemovedDuringPinEntry") is not a sentence; these are.
FAILURE_TEXT = {
    "Timeout": "the security key timed out",
    "KeyNotRegistered": "that security key is not registered for this site",
    "KeyAlreadyRegistered": "that security key is already registered",
    "SoftPinBlock": "too many wrong PINs — the key is blocked for a while; try again later",
    "HardPinBlock": "the key's PIN is blocked and needs to be reset (fido2-token)",
    "AuthenticatorRemovedDuringPinEntry": "the security key was removed during PIN entry",
    "AuthenticatorMissingResidentKeys": "the key cannot store passkeys",
    "AuthenticatorMissingUserVerification": "the key cannot verify you (no PIN or biometric)",
    "AuthenticatorMissingLargeBlob": "the key does not support large blobs",
    "NoCommonAlgorithms": "the key and the site share no supported algorithm",
    "StorageFull": "the key's storage is full",
    "UserConsentDenied": "you declined the request",
    "WinUserCancelled": "the request was cancelled",
}

# The reasons a retry can actually fix: the key is still usable, it was a timing/unplug event.
# Everything else (a blocked PIN, a missing capability) is a dead end and retrying would just
# loop, so no retry is offered for those.
RETRYABLE = frozenset({"Timeout", "AuthenticatorRemovedDuringPinEntry"})

# Qt's PinEntryReason -> the prompt's first line.
PIN_PROMPT = {
    "Set": "Set a PIN for your security key",
    "Change": "Enter your CURRENT security key PIN",
    "Challenge": "Enter your security key PIN",
}

# Key -> what the suggestion list should do. Kept as a plain table so both the widget and the
# tests speak the same names; the widget turns Qt key codes into these names.
KEY_ACTIONS = {
    "Down": "down", "j": "down", "J": "down",
    "Up": "up", "k": "up", "K": "up",
    "Return": "accept", "Enter": "accept",
    "Escape": "dismiss",
}


def step_index(current, count, delta):
    """Move a list cursor by `delta`, clamped to [0, count-1] (0 when the list is empty)."""
    if count <= 0:
        return 0
    return min(max(current + delta, 0), count - 1)


def key_action(name):
    """The action for a key name ('down' / 'up' / 'accept' / 'dismiss'), or None."""
    return KEY_ACTIONS.get(name)


def place_popup(anchor, viewport, size):
    """Where to put a popup of `size` near `anchor`, clamped inside `viewport`.

    anchor/viewport are (x, y, w, h) in the same (global) coordinate space; `size` is (w, h).
    The popup is placed just below the anchor, then clamped so it can never leave the viewport.
    """
    ax, ay, _aw, ah = anchor
    vx, vy, vw, vh = viewport
    px = min(max(ax, vx), vx + vw - size[0])
    py = min(max(ay + ah + 2, vy), vy + vh - size[1])
    return px, py


def _notice(text):
    """A non-blocking message: a tap happens outside the browser's control."""
    try:
        from qutebrowser.utils import message
        message.info(text)
    except Exception:
        log.webview.info(text)


def _val(obj, name, default=None):
    """Read a QWebEngineWebAuthUxRequest member, calling it if it is a getter.

    Qt exposes these as methods (``request.state()``), not properties; calling a plain attribute
    would hand on the bound method and every state comparison would silently fall through.
    """
    try:
        value = getattr(obj, name)
    except Exception:
        return default
    if callable(value):
        try:
            return value()
        except Exception:
            return default
    return value


def _state_name(state):
    return getattr(state, "name", None) or str(state)


def _name(obj, default):
    """The ``.name`` of an enum member, or `default` when there is none.

    Written as a ternary rather than ``getattr(...) or default`` on purpose: an ``or`` here has a
    twin (``and``) that behaves identically whenever the first operand is falsy, so no test could
    ever tell the two apart and the mutant would be unkillable.
    """
    value = getattr(obj, "name", None)
    return value if value else default


def _failure_text(reason):
    """Human wording for a RequestFailureReason (raw enum name as the last resort)."""
    name = _name(reason, "unknown")
    return FAILURE_TEXT.get(name, "security key error (%s)" % name)


def _retryable(reason):
    """True when a retry could succeed: the key is fine, the attempt just failed."""
    return _name(reason, "") in RETRYABLE


def _pin_message(pin_request):
    """The PIN dialog's label: reason, the last error, the minimum length and attempts left.

    Every one of these is carried on Qt's ``pinRequest`` and every one matters. Without the error
    a wrong PIN is re-asked with no explanation and the user repeats it; without the minimum a
    "set" prompt loops on "too short"; without the remaining-attempt count the user erases the
    key's PIN without ever being warned.
    """
    lines = [PIN_PROMPT.get(_name(getattr(pin_request, "reason", None), "Challenge"),
                            "Enter your security key PIN")]
    error = _name(getattr(pin_request, "error", None), "NoError")
    error_line = {
        "WrongPin": "That PIN was wrong.",
        "TooShort": "That PIN is too short.",
        "InvalidCharacters": "That PIN contains invalid characters.",
        "SameAsCurrentPin": "The new PIN must differ from the current one.",
        "InternalUvLocked": "The key's built-in verification is locked; use the PIN.",
    }.get(error)
    if error_line:
        lines.append(error_line)
    minimum = getattr(pin_request, "minPinLength", 0)
    if _name(getattr(pin_request, "reason", None), "Challenge") == "Set" and minimum:
        lines.append("Use at least %d characters." % minimum)
    remaining = getattr(pin_request, "remainingAttempts", -1)
    if isinstance(remaining, int) and 0 <= remaining <= 2:
        lines.append("%d attempt(s) left before the key locks." % remaining)
    return " ".join(lines)


def _ask_pin(pin_request):
    """Prompt for the token's PIN, explaining the reason, the last error and the limits.

    A PIN is a secret the user is actively typing, so this one stays a focused modal dialog: there
    is nothing to suggest and nothing to do in the page until it returns.
    """
    from PyQt6.QtWidgets import QInputDialog, QLineEdit
    prompt = _pin_message(pin_request)
    try:
        text, ok = QInputDialog.getText(None, "Security key PIN", prompt,
                                        QLineEdit.EchoMode.Password)
    except Exception:
        log.webview.exception("could not show the security key PIN prompt")
        return None
    return text if ok else None


def _ask_retry(text):
    """Offer to retry a recoverable failure rather than abandoning the sign-in."""
    from PyQt6.QtWidgets import QMessageBox
    try:
        answer = QMessageBox.question(None, "Security key", "%s.\n\nTry again?" % text)
    except Exception:
        log.webview.exception("could not ask whether to retry")
        return False
    return answer == QMessageBox.StandardButton.Yes


def _colors():
    """The applied Omarchy theme's colours for the popup, or {} when it cannot be read.

    Read live (``themes.live_theme``), never a frozen palette, so the suggestion list follows the
    desktop the same way the rest of the browser does.
    """
    try:
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import themes
        _name_, palette = themes.live_theme()
        return palette if palette else {}
    except Exception:
        return {}


def _view_for(page):
    """The widget showing `page`, if it can be found (Qt exposes no page -> view link)."""
    try:
        from PyQt6.QtWidgets import QApplication
    except Exception:
        return None
    for widget in QApplication.allWidgets():
        try:
            if hasattr(widget, "page") and widget.page() is page:
                return widget
        except Exception:
            continue
    return None


class _AccountPopup:
    """A non-modal list of the token's passkeys, anchored to the page.

    Built lazily so the module still imports (and its pure logic still runs) without Qt. The
    *shape* of the widget is kept out of the logic: what keys do, how the cursor moves and where
    the popup lands are all pure functions above, which is what the tests pin.
    """

    def __init__(self, names, callback):
        from PyQt6.QtCore import Qt
        from PyQt6.QtWidgets import QListWidget, QListWidgetItem, QWidget

        self._names = list(names)
        self._callback = callback
        self._done = False
        self._index = 0
        outer = self

        # Qt dispatches events to C++ virtuals, so the handlers must be real overrides - assigning
        # keyPressEvent as an instance attribute would never be called. Hence a subclass per popup.
        class _Popup(QWidget):
            def keyPressEvent(inner, event):
                outer._on_key(event)

            def closeEvent(inner, event):
                outer._on_close(event)

        width = 300
        height = min(len(self._names) * 28 + 8, 240)
        self.size = (width, height)
        self._widget = _Popup(None, Qt.WindowType.FramelessWindowHint
                              | Qt.WindowType.Tool | Qt.WindowType.WindowStaysOnTopHint)
        self._widget.setFixedSize(width, height)
        self._list = QListWidget(self._widget)
        self._list.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._list.setGeometry(0, 0, width, height)
        for name in self._names:
            QListWidgetItem(name, self._list)

        colors = _colors()
        bg = colors.get("bg_dark") or colors.get("bg") or "#1e1e2e"
        fg = colors.get("fg") or "#cdd6f4"
        accent = colors.get("accent") or "#89b4fa"
        self._widget.setStyleSheet(
            "QWidget{background:%s;border:1px solid %s;}"
            "QListWidget{background:%s;color:%s;border:0;outline:0;padding:4px;}"
            "QListWidget::item{padding:4px 8px;}"
            "QListWidget::item:selected{background:%s;color:%s;}"
            % (bg, accent, bg, fg, accent, bg))
        self._list.setCurrentRow(0)
        self._list.itemClicked.connect(self._accept_current)
        self._list.itemActivated.connect(self._accept_current)

    def show_at(self, anchor, viewport):
        self._widget.move(*place_popup(anchor, viewport, self.size))
        self._widget.show()
        self._widget.raise_()
        self._widget.activateWindow()
        self._list.setFocus()

    def _on_key(self, event):
        action = key_action(_key_name(event))
        if action is None:
            return
        if action == "down":
            self._move(1)
        elif action == "up":
            self._move(-1)
        elif action == "accept":
            self._accept_current()
        else:
            self._dismiss()

    def _move(self, delta):
        self._index = step_index(self._index, len(self._names), delta)
        self._list.setCurrentRow(self._index)

    def _accept_current(self, *_args):
        row = self._list.currentRow()
        name = self._names[row] if 0 <= row < len(self._names) else None
        self._finish(name)

    def _dismiss(self):
        self._finish(None)

    def _on_close(self, event):
        # A popup closed without a choice (focus loss, Escape, the window going away) is a cancel.
        self._finish(None)

    def _finish(self, name):
        if self._done:
            return
        self._done = True
        try:
            self._widget.close()
        except Exception:
            pass
        self._callback(name)


def _key_name(event):
    """Qt key event -> the name KEY_ACTIONS speaks ('Down', 'Return', 'j', ...)."""
    from PyQt6.QtCore import Qt
    names = {Qt.Key.Key_Down: "Down", Qt.Key.Key_Up: "Up", Qt.Key.Key_Return: "Return",
             Qt.Key.Key_Enter: "Enter", Qt.Key.Key_Escape: "Escape"}
    if event.key() in names:
        return names[event.key()]
    return event.text()


def _choose_account(page, names, callback):
    """Show the passkey chooser: a single key is taken as-is, several go through the popup.

    `callback` receives the chosen name, or None if the user declined. The popup is non-modal, so
    the browser stays usable while it is open — the point of an autofill suggestion.
    """
    names = list(names or [])
    if not names:
        callback(None)
        return
    if len(names) == 1:
        callback(names[0])
        return
    try:
        popup = _AccountPopup(names, callback)
    except Exception:
        log.webview.exception("could not show the account chooser")
        callback(None)
        return
    view = _view_for(page)
    if view is None:
        popup.show_at((0, 0, 0, 0), (0, 0, 0, 0))
        return
    try:
        origin = view.mapToGlobal(view.rect().topLeft())
        anchor = (origin.x(), origin.y(), 0, 0)
        viewport = (origin.x(), origin.y(), view.width(), view.height())
        popup.show_at(anchor, viewport)
    except Exception:
        log.webview.exception("could not place the account chooser")
        popup.show_at((0, 0, 0, 0), (0, 0, 0, 0))


def handle(page, request, choose=None):
    """Drive one WebAuthn UX request to completion, cancellation, or failure."""
    chooser = choose or _choose_account
    log.webview.debug("WebAuthn UX request for rp=%r" % (_val(request, "relyingPartyId", ""),))

    def on_state(state):
        name = _state_name(state)
        log.webview.debug("WebAuthn UX state: %s" % name)
        try:
            if name == "CollectPin":
                pin = _ask_pin(_val(request, "pinRequest"))
                if pin is None:
                    request.cancel()
                else:
                    request.setPin(pin)
            elif name == "SelectAccount":
                names = list(_val(request, "userNames") or [])

                def picked(account):
                    if account:
                        request.setSelectedAccount(account)
                    else:
                        request.cancel()

                chooser(page, names, picked)
            elif name == "FinishTokenCollection":
                _notice("Touch your security key to sign in to %s"
                        % (_val(request, "relyingPartyId", "") or "this site"))
            elif name == "RequestFailed":
                reason = _val(request, "requestFailureReason")
                text = _failure_text(reason)
                _notice("Security key: %s" % text)
                if _retryable(reason) and _ask_retry(text):
                    request.retry()
            elif name == "Completed":
                _notice("Signed in with your security key")
            elif name == "Cancelled":
                _notice("Security key request cancelled")
        except Exception:
            log.webview.exception("WebAuthn UX handler failed in state %s" % name)

    try:
        request.stateChanged.connect(on_state)
    except Exception:
        log.webview.exception("could not follow the WebAuthn UX request")
    try:
        on_state(_val(request, "state"))
    except Exception:
        log.webview.exception("WebAuthn UX: could not read the initial state")


def attach(page):
    """Connect the handler to one page, once."""
    try:
        if getattr(page, "_omarchy_webauthn", False):
            return
        page._omarchy_webauthn = True
        page.webAuthUxRequested.connect(lambda request: handle(page, request))
    except Exception:
        log.webview.exception("could not attach the WebAuthn UX handler")


def sweep():
    """Attach to every page that exists, including ones created before we loaded.

    Patching the constructors only covers pages created afterwards, and qutebrowser builds its
    first tab before user config runs. Walking the live widgets catches those.
    """
    try:
        from PyQt6.QtWebEngineCore import QWebEnginePage
        from PyQt6.QtWidgets import QApplication
    except Exception:
        return
    for widget in QApplication.allWidgets():
        try:
            if isinstance(widget, QWebEnginePage):
                attach(widget)
                continue
            page = widget.page() if hasattr(widget, "page") else None
            if isinstance(page, QWebEnginePage):
                attach(page)
        except Exception:
            continue


def install():
    """Attach to present and future pages. Idempotent, and safe to call from config."""
    from PyQt6.QtCore import QTimer

    if getattr(install, "_done", False):
        return
    install._done = True
    try:
        from qutebrowser.browser.webengine import webview

        page_class = webview.WebEnginePage
        if not getattr(page_class, "_omarchy_webauthn_init", False):
            page_class._omarchy_webauthn_init = True
            original = page_class.__init__

            def init(self, *args, **kwargs):
                original(self, *args, **kwargs)
                attach(self)

            page_class.__init__ = init

        view_class = webview.WebEngineView
        if not getattr(view_class, "_omarchy_webauthn_init", False):
            view_class._omarchy_webauthn_init = True
            voriginal = view_class.__init__

            def vinit(self, *args, **kwargs):
                voriginal(self, *args, **kwargs)
                try:
                    attach(self.page())
                except Exception:
                    log.webview.exception("could not attach via the view")

            view_class.__init__ = vinit
    except Exception:
        log.webview.exception("could not patch the page classes; falling back to the sweep")

    # Catch anything built before this module loaded, then keep watching: pages appear on restore,
    # on tab creation and on window.open, and a cheap walk is more dependable than guessing all
    # the ways a page can come into being.
    timer = QTimer()
    timer.timeout.connect(sweep)
    timer.start(2000)
    QTimer.singleShot(0, sweep)
    sweep()
    log.webview.info("WebAuthn UX handler installed (constructor hooks + sweep)")

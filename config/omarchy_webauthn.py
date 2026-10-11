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


def _ask_pin(reason):
    """Prompt for the token's PIN. ``reason`` is Qt's PinEntryReason."""
    from PyQt6.QtWidgets import QInputDialog, QLineEdit
    name = getattr(reason, "name", str(reason))
    prompt = {
        "Set": "Set a PIN for your security key",
        "Change": "Enter your CURRENT security key PIN",
        "Challenge": "Enter your security key PIN",
    }.get(name, "Enter your security key PIN")
    try:
        text, ok = QInputDialog.getText(None, "Security key PIN", prompt,
                                        QLineEdit.EchoMode.Password)
    except Exception:
        log.webview.exception("could not show the security key PIN prompt")
        return None
    return text if ok else None


def _ask_account(names):
    """Pick one of the discoverable credentials the token holds."""
    from PyQt6.QtWidgets import QInputDialog
    names = list(names or [])
    if not names:
        return None
    if len(names) == 1:
        return names[0]
    try:
        choice, ok = QInputDialog.getItem(None, "Choose an account", "Sign in with:",
                                          names, 0, False)
    except Exception:
        log.webview.exception("could not show the account chooser")
        return None
    return choice if ok else None


def handle(request):
    """Drive one WebAuthn UX request to completion, cancellation, or failure."""
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
                account = _ask_account(_val(request, "userNames"))
                if account:
                    request.setSelectedAccount(account)
                else:
                    request.cancel()
            elif name == "FinishTokenCollection":
                _notice("Touch your security key to sign in to %s"
                        % (_val(request, "relyingPartyId", "") or "this site"))
            elif name == "RequestFailed":
                reason = _val(request, "requestFailureReason")
                _notice("Security key error: %s" % getattr(reason, "name", reason))
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
        page.webAuthUxRequested.connect(handle)
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

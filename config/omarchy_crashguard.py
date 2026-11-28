"""Reload a tab whose renderer died, so an engine crash costs a reload, not a dead tab.

QtWebEngine 6.11.2 -- what the stable package channel ships -- dies with SIGTRAP (a Chromium
CHECK failure, QTBUG-149435) on some pages; a frame declaring a legacy charset such as
iso-8859-2 is enough to trigger it. qutebrowser only prints "Renderer process crashed" and
leaves the tab dead until the user reloads it by hand, which is precisely the wrong outcome
for a browser that has to be usable: the fix (6.11.3+) is not on the stable channel yet.

So the browser heals itself. Two reloads per URL per five minutes, then it stops and leaves
qutebrowser's own error page: a page that crashes on every single load must not become a
reload loop that fights the user's tab.

The decision logic is pure and lives in `handle_termination` so it can be tested without Qt;
`install()` is the only part that touches the browser.
"""

MAX_RELOADS = 2
RETRY_WINDOW_MS = 5 * 60 * 1000
SWEEP_MS = 2000

# URLs whose renderer dying is not something a reload can fix.
_NOT_WORTH_RELOADING = ("qute://", "about:", "chrome-error://", "data:", "view-source:")

# url -> list of monotonic timestamps of the reloads we already tried
_attempts = {}

# tab id -> the last real page it was on. qutebrowser swaps the tab to a data: error page
# BEFORE our slot runs (its own handler is connected first, at tab creation), so reading
# tab.url() here gives the error page and never the page that actually crashed.
_last_url = {}


def recent_attempts(history, now, window=RETRY_WINDOW_MS):
    """The attempts inside the window, oldest first. Drops what has aged out."""
    return [attempt for attempt in history if now - attempt < window]


def may_reload(history, now):
    """True while this URL still has reload budget left."""
    return len(recent_attempts(history, now)) < MAX_RELOADS


def record_attempt(history, now):
    """Add `now` to `history`, forgetting aged-out attempts. Returns the history."""
    history[:] = recent_attempts(history, now)
    history.append(now)
    return history


def is_worth_reloading(url):
    """Internal pages and non-URLs are not repaired by reloading."""
    if not url:
        return False
    return not url.startswith(_NOT_WORTH_RELOADING)


def remember(store, key, url):
    """Keep the last URL that is worth reloading; an error page must not overwrite it.

    Returns what the store holds for `key` afterwards, so the crash handler has the page
    to go back to even though the tab has already been replaced by qutebrowser's own
    data: error page.
    """
    if is_worth_reloading(url):
        store[key] = url
    return store.get(key, "")


def handle_termination(url, now, history, crashed):
    """Decide whether to reload, and book the attempt if so.

    Pure apart from the `history` list it is handed, so the tests can drive the whole
    budget without a browser: three crashes in a row give two reloads, not three.
    """
    if not crashed:
        return False
    if not is_worth_reloading(url):
        return False
    if not may_reload(history, now):
        return False
    record_attempt(history, now)
    return True


def _qurl(url):
    """Build a QUrl. Imported here because the unit tests run without Qt installed."""
    from qutebrowser.qt.core import QUrl

    return QUrl(url)


def _on_terminated(page, status, code, message, now_ms, to_url=_qurl):
    """Qt slot: book the crash and send the page back when the budget allows."""
    try:
        url = _last_url.get(id(page), "")
        crashed = "crashed" in str(status).lower()
        history = _attempts.setdefault(url, [])
        attempt = len(recent_attempts(history, now_ms)) + 1
        if handle_termination(url, now_ms, history, crashed):
            message.info("Renderer crashed; reloading {} (attempt {}/{})".format(
                url, attempt, MAX_RELOADS))
            page.setUrl(to_url(url))
        elif crashed and is_worth_reloading(url):
            message.warning("Renderer keeps crashing on {}; leaving the error page".format(url))
    except Exception:                   # never let a crash handler crash the browser
        try:
            from qutebrowser.utils import log

            log.webview.exception("crash guard failed")
        except Exception:               # not even the logging is guaranteed (unit tests)
            pass


def attach(page, now_ms, message, to_url=_qurl):
    """Connect the guard to one page. Returns False if it was already connected."""
    if getattr(page, "_omarchy_crash_guard", False):
        return False
    page._omarchy_crash_guard = True
    try:
        remember(_last_url, id(page), page.url().toString())
    except Exception:
        pass
    page.urlChanged.connect(
        lambda url, page=page: remember(_last_url, id(page), url.toString()))
    page.renderProcessTerminated.connect(
        lambda status, code, page=page: _on_terminated(
            page, status, code, message, now_ms(), to_url))
    return True


def sweep(now_ms, message):
    """Attach to every live page, including the ones built before this module loaded."""
    from qutebrowser.qt.core import QUrl  # noqa: F401  (import proves Qt is usable here)
    from qutebrowser.qt.webenginecore import QWebEnginePage
    from qutebrowser.qt.widgets import QApplication

    for widget in QApplication.allWidgets():
        try:
            page = widget if isinstance(widget, QWebEnginePage) else (
                widget.page() if hasattr(widget, "page") else None)
            if isinstance(page, QWebEnginePage):
                attach(page, now_ms, message)
        except Exception:
            continue


def install():
    """Wire the guard into a running browser. A no-op in a command-only process."""
    import sys
    import time

    from qutebrowser.qt.core import QTimer
    from qutebrowser.utils import log, message

    # Same trap as the WebAuthn handler: `qutebrowser :jseval` and friends load the config
    # for an IPC hop and destroy the dispatcher at exit, so a timer there only produces
    # "current thread's event dispatcher has already been destroyed".
    if any(arg.startswith(":") for arg in sys.argv[1:]):
        log.webview.debug("crash guard: command invocation, not starting the sweep timer")
        return

    def now_ms():
        return int(time.monotonic() * 1000)

    def run():
        sweep(now_ms, message)

    timer = QTimer()
    timer.timeout.connect(run)
    timer.start(SWEEP_MS)
    QTimer.singleShot(0, run)
    run()
    log.webview.info("crash guard installed (reload a crashed tab, at most {}x per {} min)".format(
        MAX_RELOADS, RETRY_WINDOW_MS // 60000))
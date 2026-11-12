#!/usr/bin/env python3
"""e2e driver: run the REAL LinkedIn redirect script against the REAL QtWebEngine, offscreen.

The unit tests evaluate the script in a sandbox and the regression tests read its text. Neither can
show the thing that matters: that on the live block page - a 403 document Cloudflare serves with a
Ray ID - the script is injected at all, sees the page, and gets out. This drives the actual engine
with the actual script over the actual URL and reports what happened.

Two scenarios, one engine:

  1. https://www.linkedin.com/  - the URL measured to be hard-blocked. Expected: the block page is
     seen and the browser ends up on https://www.linkedin.com/login/.
  2. https://www.linkedin.com/login/ - the destination. Expected: it stays put (the loop guard),
     which is what stops a block page served ON the login path from bouncing forever.

An observer script reports, per document, whether that document was a block page. Its reports come
back over the page's own console, which survives the redirect and needs no storage. That is how a
run distinguishes "escaped the block" from "there was no block to escape" - LinkedIn promises
neither. The observer is injected BEFORE the redirect script so its DOMContentLoaded handler runs
first and the block page is on record before the navigation starts.

Output is the E2E KEY=value convention the other drivers use.
"""
import json
import os
import pathlib
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = REPO / "userscripts" / "omarchy-linkedin-root-redirect.js"

ROOT_URL = "https://www.linkedin.com/"
LOGIN_URL = "https://www.linkedin.com/login/"

# Throwaway XDG dirs: a second QtWebEngine profile on shared dirs aborts, and the user's live
# browser must not be touched (its cookies, its singleton lock, its profile).
tmp = tempfile.mkdtemp(prefix="li-redirect-e2e-")
for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"):
    os.environ[var] = tmp
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--no-sandbox --disable-gpu --disable-dev-shm-usage")

from PyQt6.QtCore import QTimer, QUrl                                          # noqa: E402
from PyQt6.QtWebEngineCore import (QWebEnginePage, QWebEngineProfile,          # noqa: E402
                                   QWebEngineScript)
from PyQt6.QtWidgets import QApplication                                       # noqa: E402

# Reports, per document, what that document was. The message goes to the page's console, which the
# driver collects - a document that is navigated away from cannot be read afterwards.
OBSERVER = r"""
(function () {
    'use strict';
    try {
        function report() {
            var title = document.title || '';
            var text = document.body ? (document.body.textContent || '') : '';
            console.log('OMARCHY_E2E ' + JSON.stringify({
                url: location.href,
                title: title,
                blocked: /attention required/i.test(title) || /you have been blocked/i.test(text)
            }));
        }
        if (document.readyState === 'interactive' || document.readyState === 'complete') { report(); }
        else { document.addEventListener('DOMContentLoaded', report); }
    } catch (e) { /* the observer must never interfere */ }
})();
"""

MARKER = "OMARCHY_E2E "
SETTLE_MS = 7000


class ConsolePage(QWebEnginePage):
    """Collects the observer's reports; qutebrowser's message bar is the other channel, this is the
    one available offscreen."""

    def __init__(self, profile, records):
        super().__init__(profile)
        self.records = records

    def javaScriptConsoleMessage(self, level, message, line, source):          # noqa: N802
        if isinstance(message, str) and message.startswith(MARKER):
            try:
                self.records.append(json.loads(message[len(MARKER):]))
            except ValueError:
                pass
        return super().javaScriptConsoleMessage(level, message, line, source)


def add_script(profile, name, source):
    script = QWebEngineScript()
    script.setName(name)
    script.setSourceCode(source)
    script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
    script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
    script.setRunsOnSubFrames(False)
    profile.scripts().insert(script)


def main():
    app = QApplication([sys.argv[0]])
    profile = QWebEngineProfile("li-redirect-e2e")
    # What qutebrowser sends these hosts (see config/config.py): a plain Chrome UA.
    profile.setHttpUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                             "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
    add_script(profile, "omarchy-e2e-observer", OBSERVER)
    add_script(profile, "omarchy-linkedin-root-redirect", SCRIPT.read_text())  # @run-at document-start

    records = []
    page = ConsolePage(profile, records)
    urls = [ROOT_URL, LOGIN_URL]
    state = {"i": -1, "results": []}

    def collect():
        state["results"].append({"records": list(records), "final": page.url().toString(),
                                 "mark": state.get("mark", 0)})
        QTimer.singleShot(250, step)

    def step():
        state["i"] += 1
        if state["i"] >= len(urls):
            emit()
            return
        state["mark"] = len(records)
        page.setUrl(QUrl(urls[state["i"]]))
        QTimer.singleShot(SETTLE_MS, collect)

    def emit():
        for index, url in enumerate(urls):
            result = (state["results"][index] if index < len(state["results"])
                      else {"records": [], "final": "", "mark": 0})
            print("E2E TARGET_%d=%s" % (index, url))
            print("E2E FINAL_%d=%s" % (index, result["final"]))
            print("E2E RECORDS_%d=%s" % (index, json.dumps(result["records"][result["mark"]:])))
        app.quit()

    QTimer.singleShot(100000, lambda: (print("E2E TIMEOUT=1"), app.quit()))
    QTimer.singleShot(0, step)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())

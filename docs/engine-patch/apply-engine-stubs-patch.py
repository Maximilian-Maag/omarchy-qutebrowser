#!/usr/bin/env python3
"""Fill in QtWebEngine's declared-but-missing implementations (its own stub markers).

Two kinds of stub exist in Qt's own sources, and the repo's earlier gap register only ever scanned
for the first:

  * NOTIMPLEMENTED()          - Chromium's macro (core/clipboard_qt.cpp, autofill_client_qt.cpp, ...)
  * QT_NOT_YET_IMPLEMENTED    - Qt's own macro, defined in core/api/qtwebenginecoreglobal_p.h, used
                                ~20 times across core/ and NOT covered by the earlier scan

This script implements the stubs that are real, reachable on this build, and safely implementable
with the interfaces already available (see docs/implementation-gaps.md for the full triage of the
rest). Each edit is the *inverse* of behaviour Qt already ships in the same file, so the change is
small and reviewable:

  1. BrowserAccessibilityInterface::characterRect()          - the rect of one character
  2. BrowserAccessibilityInterface::offsetAtPoint()          - the inverse of characterRect
  3. BrowserAccessibilityInterface::keyBindingsForAction()   - the element's shortcut (kKeyShortcuts)
  4. ClipboardQt::ReadBookmark()                             - decode text/x-moz-url, the exact
                                                               inverse of the WriteBookmark() Qt
                                                               already implements

Modes (same contract as apply-webauthn-patch.py):
  (default)     apply the fixes to the source in place
  --revert      restore the original stub text in place
  --check       classify each fix patched / appliable / drift WITHOUT writing; exit 2 on drift
  --src DIR     operate on DIR instead of the default checkout (for --check in the test suite)

A text-matched patch is one Qt refactor away from being a silent no-op, so --check is the guard:
an upgrade that moves an anchor makes this exit non-zero instead of quietly shipping without the
implementations.
"""
import pathlib
import sys

SRC_DEFAULT = pathlib.Path.home() / "Work/qt6-webengine-build/qt6-webengine/src/qtwebengine/src/core"

# ---- 1. characterRect ------------------------------------------------------
# rect() establishes the coordinate convention: Blink screen bounds scaled by the device scale
# factor. scrollToSubstring() already uses the hypertext-range-bounds API to locate a range.
ACK_OLD = """QRect BrowserAccessibilityInterface::characterRect(int /*offset*/) const
{
    QT_NOT_YET_IMPLEMENTED
    return QRect();
}"""

ACK_NEW = """QRect BrowserAccessibilityInterface::characterRect(int offset) const
{
    // The bounds of a single character, in the same coordinate convention as rect(): Blink's
    // screen bounds divided by the device scale factor. The range-bounds API is the one
    // scrollToSubstring() already uses a few functions below.
    if (!q->manager() || !q->isReady()) // needed implicitly by the bounds call
        return QRect();
    if (offset < 0 || offset >= characterCount())
        return QRect();
    gfx::Rect bounds =
            q->GetScreenHypertextRangeBoundsRect(offset, 1, ui::AXClippingBehavior::kUnclipped);
    bounds = gfx::ScaleToRoundedRect(bounds, 1.f / q->manager()->device_scale_factor());
    return QRect(bounds.x(), bounds.y(), bounds.width(), bounds.height());
}"""

# ---- 2. offsetAtPoint ------------------------------------------------------
# Blink exposes no point->offset call to this interface, so scan the character rects. This mirrors
# Chromium's own Linux ATK implementation (AXPlatformNodeAuraLinux::GetTextOffsetAtPoint), which
# does exactly this loop. Qt's contract: -1 when no character is at the point.
AOP_OLD = """int BrowserAccessibilityInterface::offsetAtPoint(const QPoint &/*point*/) const
{
    QT_NOT_YET_IMPLEMENTED
    return 0;
}"""

AOP_NEW = """int BrowserAccessibilityInterface::offsetAtPoint(const QPoint &point) const
{
    // The inverse of characterRect(). Blink exposes no point->offset call to this interface, so
    // scan the character rects - the same approach as Chromium's own
    // AXPlatformNodeAuraLinux::GetTextOffsetAtPoint. Qt expects -1 when no character is there.
    const int count = characterCount();
    for (int i = 0; i < count; ++i) {
        if (characterRect(i).contains(point))
            return i;
    }
    return -1;
}"""

# ---- 3. keyBindingsForAction ----------------------------------------------
KB_OLD = """BrowserAccessibilityInterface::keyBindingsForAction(const QString & /*actionName*/) const
{
    QT_NOT_YET_IMPLEMENTED
    return QStringList();
}"""

KB_NEW = """BrowserAccessibilityInterface::keyBindingsForAction(const QString &actionName) const
{
    // The only action this interface reports is setFocus (see actionNames()); the element's own
    // keyboard shortcut is the honest answer for it, and Blink exposes it as kKeyShortcuts (the
    // same attribute text(QAccessible::Accelerator) already returns).
    QStringList bindings;
    if (actionName == QAccessibleActionInterface::setFocusAction()) {
        const QString shortcuts =
                toQt(q->GetStringAttribute(ax::mojom::StringAttribute::kKeyShortcuts));
        const auto parts = shortcuts.split(u',', Qt::SkipEmptyParts);
        for (const QString &part : parts) {
            const QString trimmed = part.trimmed();
            if (!trimmed.isEmpty())
                bindings.append(trimmed);
        }
    }
    return bindings;
}"""

# ---- 4. ClipboardQt::ReadBookmark -----------------------------------------
# WriteBookmark() (a few hundred lines up in the same file) writes text/x-moz-url as a UTF-16
# (URL, newline, title) string. ReadBookmark() must decode that same layout. Chromium's own Linux
# clipboard leaves this NOTIMPLEMENTED (clipboard_ozone.cc: "left NOTIMPLEMENTED() in all the Linux
# platforms"), so this is an improvement over the platform default, not just catching up to it.
RB_OLD = """void ClipboardQt::ReadBookmark(const ui::DataTransferEndpoint *data_dst, std::u16string *title, std::string *url) const
{
    NOTIMPLEMENTED();
}"""

RB_NEW = """void ClipboardQt::ReadBookmark(const ui::DataTransferEndpoint *data_dst, std::u16string *title, std::string *url) const
{
    Q_UNUSED(data_dst);
    const QMimeData *mimeData = QGuiApplication::clipboard()->mimeData();
    if (!mimeData)
        return;

    // The mozilla url format WriteBookmark() writes: a UTF-16 (URL, newline, title) payload under
    // "text/x-moz-url". Decode its exact inverse.
    const QByteArray data = mimeData->data(QString::fromLatin1(ui::kMimeTypeMozillaUrl));
    if (data.isEmpty())
        return;

    const QString bookmark = QString::fromUtf16(
            reinterpret_cast<const char16_t *>(data.constData()), data.size() / 2);
    const qsizetype newline = bookmark.indexOf(u'\\n');
    const QString bookmarkUrl = newline < 0 ? bookmark : bookmark.left(newline);
    if (url)
        *url = bookmarkUrl.toStdString();
    if (title)
        *title = toString16(newline < 0 ? QString() : bookmark.mid(newline + 1));
}"""

# file -> list of (old, new, marker). The marker is a string that appears ONLY once patched, so it
# answers "is this applied?"; the old text answers "can this still be applied?".
EDIT_FILES = [
    ("browser_accessibility_qt.cpp", [
        (ACK_OLD, ACK_NEW, "GetScreenHypertextRangeBoundsRect"),
        (AOP_OLD, AOP_NEW, "no point->offset call to this interface"),
        (KB_OLD, KB_NEW, "the element's own\n    // keyboard shortcut is the honest answer"),
    ]),
    ("clipboard_qt.cpp", [
        (RB_OLD, RB_NEW, "mozilla url format WriteBookmark() writes"),
    ]),
]


def status(src):
    """Classify each fix patched / appliable / drift, without touching the files."""
    st = {}
    for name, edits in EDIT_FILES:
        path = src / name
        text = path.read_text() if path.exists() else None
        for old, new, marker in edits:
            key = "%s:%s" % (name, marker[:28])
            if text is None:
                st[key] = "missing"
            elif marker in text:
                st[key] = "patched"
            elif old in text:
                st[key] = "appliable"
            else:
                st[key] = "drift"
    return st


def check(src):
    if not all((src / name).exists() for name, _ in EDIT_FILES):
        print("  source not found under %s" % src, file=sys.stderr)
        return 3
    st = status(src)
    print("  engine source: %s" % src)
    for key, value in st.items():
        print("  %-40s %s" % (key, value))
    if any(v in ("drift", "missing") for v in st.values()):
        print("  ANCHOR DRIFT: a Qt source change broke the patch. Re-derive the anchors before "
              "building, or the engine will silently ship without these implementations.",
              file=sys.stderr)
        return 2
    if all(v == "patched" for v in st.values()):
        print("  OK: patched")
    else:
        print("  OK: appliable")
    return 0


def revert(src):
    """Restore each stub's original text (replace NEW -> OLD)."""
    done = False
    for name, edits in EDIT_FILES:
        path = src / name
        if not path.exists():
            continue
        text = path.read_text()
        for old, new, _ in edits:
            if new in text:
                text = text.replace(new, old, 1)
                done = True
        path.write_text(text)
    if not done:
        print("  nothing to revert (patch not present)")
    else:
        print("  reverted the engine stub implementations")


def apply_patch(src):
    """Apply every edit to ONE in-memory copy of each file, then write each file once.

    (Reading, patching and writing a file twice is how a second fix silently clobbers the first -
    see the note in apply-webauthn-patch.py.)
    """
    problems = []
    for name, edits in EDIT_FILES:
        path = src / name
        if not path.exists():
            problems.append("%s (file missing)" % name)
            continue
        text = path.read_text()
        for old, new, marker in edits:
            if marker in text:
                print("  already applied:", name, "/", marker[:40])
            elif old in text:
                text = text.replace(old, new, 1)
                print("  applied:", name, "/", marker[:40])
            else:
                problems.append("%s: anchor for %r" % (name, marker[:40]))
        path.write_text(text)
    if problems:
        print("  ANCHOR NOT FOUND: %s - the source layout changed" % "; ".join(problems),
              file=sys.stderr)
        return 1
    return 0


def main(argv):
    src = SRC_DEFAULT
    if "--src" in argv:
        src = pathlib.Path(argv[argv.index("--src") + 1])
    if "--check" in argv:
        return check(src)
    if "--revert" in argv:
        revert(src)
        return 0
    return apply_patch(src)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

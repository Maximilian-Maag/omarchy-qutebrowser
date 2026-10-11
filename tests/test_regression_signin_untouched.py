"""Nothing we ship may rewrite the browser's own APIs.

The `google-signin-compat.js` shim did exactly that, and it became the reason sign-in was refused:
it redefined `navigator.userAgentData` as an *own* property on the navigator instance (real Chrome
keeps it on `Navigator.prototype`), populated `window.chrome`, and deleted `PublicKeyCredential` on
Microsoft hosts. Google's submit-time integrity check read that surgery as a tampered browser and
answered "This browser or app may not be secure" — while the page itself loaded fine, which is why
it stayed hidden for so long.

Anything that genuinely needs to differ per host belongs in config (request headers, canvas
setting), not in JavaScript that a page can inspect. This test makes that class of change
impossible to reintroduce silently.
"""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent

# A userscript that touches any of these is rewriting the browser rather than the page.
FORBIDDEN = (
    "navigator.credentials",
    "PublicKeyCredential",
    "userAgentData",
    "navigator.plugins",
    "navigator.mimeTypes",
    "navigator.webdriver",
    "pdfViewerEnabled",
)


class SigninUntouched(unittest.TestCase):
    def test_no_shipped_userscript_touches_browser_apis(self):
        offenders = []
        for path in sorted((ROOT / "userscripts").glob("*.js")):
            text = path.read_text()
            for needle in FORBIDDEN:
                if needle in text:
                    offenders.append("%s touches %s" % (path.name, needle))
        self.assertEqual([], offenders,
                         "a userscript is rewriting the browser's own APIs:\n  "
                         + "\n  ".join(offenders))

    def test_the_shim_stays_retired(self):
        self.assertFalse((ROOT / "userscripts" / "google-signin-compat.js").exists(),
                         "google-signin-compat.js caused the sign-in refusal; keep it retired")


if __name__ == "__main__":
    unittest.main()

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

One exception exists, and it is asserted here rather than merely tolerated: the Microsoft
platform-probe, because QtWebEngine answers
`isUserVerifyingPlatformAuthenticatorAvailable()` false and Microsoft's passkey page therefore
never starts a ceremony. It corrects that single answer and nothing else, and it is deliberately
kept off Google, which refuses the sign-in for even that much. `test_the_one_exception_stays_narrow`
holds it to both conditions.
"""
import pathlib
import re
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

# The single deliberate exception, and the conditions that keep it narrow. `allowed` names the only
# browser API this file may touch; `must_not_match` names hosts it must never be scoped to, so the
# exception can never grow into the thing that broke sign-in in the first place.
EXCEPTIONS = {
    "omarchy-ms-passkey-platform-probe.js": {
        "allowed": ("PublicKeyCredential",),
        "must_not_match": ("google.com", "gstatic.com", "youtube.com", "googleusercontent.com"),
    },
}


class SigninUntouched(unittest.TestCase):
    def test_no_shipped_userscript_touches_browser_apis(self):
        offenders = []
        for path in sorted((ROOT / "userscripts").glob("*.js")):
            text = path.read_text()
            allowed = set(EXCEPTIONS.get(path.name, {}).get("allowed", ()))
            for needle in FORBIDDEN:
                if needle in text and needle not in allowed:
                    offenders.append("%s touches %s" % (path.name, needle))
        self.assertEqual([], offenders,
                         "a userscript is rewriting the browser's own APIs:\n  "
                         + "\n  ".join(offenders))

    def test_the_one_exception_stays_narrow(self):
        for name, rules in EXCEPTIONS.items():
            path = ROOT / "userscripts" / name
            self.assertTrue(path.exists(), "%s is exempted but not shipped" % name)
            text = path.read_text()
            for needle in FORBIDDEN:
                if needle in text:
                    self.assertIn(needle, rules["allowed"],
                                  "%s may touch %s only because it is listed in `allowed`"
                                  % (name, needle))
            # What actually scopes a userscript is its @match directives, so that is what is held
            # to the condition — not prose in a comment explaining the exclusion.
            patterns = re.findall(r"^//\s*@match\s+(\S+)", text, re.M)
            self.assertTrue(patterns, "%s declares no @match, so its scope is not asserted" % name)
            for pattern in patterns:
                for host in rules["must_not_match"]:
                    self.assertNotIn(host, pattern.lower(),
                                     "%s @match %s must never cover %s — Google refuses the sign-in "
                                     "for even a single corrected probe"
                                     % (name, pattern, host))

    def test_the_shim_stays_retired(self):
        self.assertFalse((ROOT / "userscripts" / "google-signin-compat.js").exists(),
                         "google-signin-compat.js caused the sign-in refusal; keep it retired")


if __name__ == "__main__":
    unittest.main()

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
    # Verified: this is what makes Google's sign-in accept the browser at all. Held to Google hosts
    # and to the three tells it needs - widening either is how the original shim broke sign-in.
    "omarchy-google-signin-chrome-identity.js": {
        "allowed": ("userAgentData", "pdfViewerEnabled"),
        "must_not_match": ("live.com", "microsoft.com", "microsoftonline.com", "apple.com"),
        "must_match_only": ("google.com",),
    },
    # The Microsoft sign-in hosts. The request half has always sent them a Chrome-branded
    # `sec-ch-ua` (config/config.py `_STOCK_CHROME_HOSTS`), and without this half the header said
    # Chrome while `navigator.userAgentData.brands` said Chromium-only. Code body identical to the
    # Google script above; held to Microsoft hosts, and never Google - Google refuses the sign-in
    # for even a single corrected probe, which is why the list below is deliberately long.
    "omarchy-ms-signin-chrome-identity.js": {
        "allowed": ("userAgentData", "pdfViewerEnabled"),
        "must_not_match": ("google.com", "gstatic.com", "youtube.com", "googleusercontent.com",
                           "linkedin.com", "kleinanzeigen.de", "immowelt.de"),
        "must_match_only": ("login.microsoftonline.com", "login.live.com", "login.microsoft.com",
                            "account.microsoft.com"),
    },
    # Same shape, different class of site: the JavaScript half of the stock-Chrome identity for
    # sites behind managed bot-detection. Kept to the bot-managed hosts so it can never drift onto
    # an auth flow, and to the same two tells so it cannot grow into the shim that broke sign-in.
    "omarchy-chrome-identity.js": {
        "allowed": ("userAgentData", "pdfViewerEnabled"),
        "must_not_match": ("google.com", "gstatic.com", "youtube.com", "googleusercontent.com",
                           "live.com", "microsoft.com", "microsoftonline.com", "apple.com"),
        "must_match_only": ("linkedin.com", "kleinanzeigen.de", "immowelt.de"),
    },
}


def code_only(text):
    """Strip comments, so a comment *naming* an API is not mistaken for a rewrite of it.

    The API scan is about what a script does, not what it says. Two subtleties, both measured:
    a URL contains `//` (`https://...`) and `/*` (`google.com/*`), so a line comment only starts at
    a `//` not preceded by a colon, and a block comment only starts at the beginning of a line.
    Getting these wrong strips the code itself and turns the scan into a no-op.
    """
    without_block = re.sub(r"(?m)^[ \t]*/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<!:)//[^\n]*", "", without_block)


class SigninUntouched(unittest.TestCase):
    def test_no_shipped_userscript_touches_browser_apis(self):
        offenders = []
        for path in sorted((ROOT / "userscripts").glob("*.js")):
            code = code_only(path.read_text())
            allowed = set(EXCEPTIONS.get(path.name, {}).get("allowed", ()))
            for needle in FORBIDDEN:
                if needle in code and needle not in allowed:
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
                if needle in code_only(text):
                    self.assertIn(needle, rules["allowed"],
                                  "%s may touch %s only because it is listed in `allowed`"
                                  % (name, needle))
            # What actually scopes a userscript is its @match directives, so that is what is held
            # to the conditions - not prose in a comment explaining the exclusion.
            patterns = re.findall(r"^//\s*@match\s+(\S+)", text, re.M)
            self.assertTrue(patterns, "%s declares no @match, so its scope is not asserted" % name)
            match_only = rules.get("must_match_only", ())
            for pattern in patterns:
                lowered = pattern.lower()
                if match_only:
                    # Each @match must sit on one of the allowed hosts. (One host -> "inside it";
                    # several -> "inside one of them".) Widening it is how the original shim broke
                    # sign-in, so an off-list pattern is a failure.
                    self.assertTrue(any(host in lowered for host in match_only),
                                    "%s @match %s must stay inside one of %s - widening it is how "
                                    "the original shim broke sign-in"
                                    % (name, pattern, ", ".join(match_only)))
                for host in rules["must_not_match"]:
                    self.assertNotIn(host, lowered,
                                     "%s @match %s must never cover %s - Google refuses the "
                                     "sign-in for even a single corrected probe"
                                     % (name, pattern, host))

    def test_the_shim_stays_retired(self):
        self.assertFalse((ROOT / "userscripts" / "google-signin-compat.js").exists(),
                         "google-signin-compat.js caused the sign-in refusal; keep it retired")


if __name__ == "__main__":
    unittest.main()


class CodeOnly(unittest.TestCase):
    """The API scan must read code, not prose - and must not eat the code either.

    Measured: a first version stripped `/*` out of `google.com/*` in an @match URL and, with
    DOTALL, ran to the next `*/`, collapsing a 4244-char script to 26 chars. Every scan then passed
    silently - worse than failing, because it looks like a guarantee.
    """

    SAMPLE = (
        "// @match       https://accounts.google.com/*\n"
        "/* a block note naming navigator.credentials */\n"
        "// a line note naming PublicKeyCredential\n"
        "var u = 'https://login.live.com/x';\n"
        "Object.defineProperty(navigator, 'userAgentData', {});\n"
        "function f() { return 1; }\n"
    )

    def test_it_keeps_the_code(self):
        code = code_only(self.SAMPLE)
        self.assertIn("Object.defineProperty(navigator, 'userAgentData', {});", code)
        # Every non-comment line must survive intact; a length ratio is fragile in a sample that is
        # deliberately comment-heavy.
        for line in self.SAMPLE.splitlines():
            if line.strip() and not line.strip().startswith(("//", "/*")):
                self.assertIn(line, code, "a code line was stripped: " + line)

    def test_a_url_star_slash_is_not_a_block_comment(self):
        code = code_only("// @match       https://accounts.google.com/*\nvar a = 1;\nvar b = 2;")
        self.assertIn("var a = 1;", code)
        self.assertIn("var b = 2;", code)

    def test_url_slashes_are_not_a_line_comment(self):
        self.assertIn("https://login.live.com/", code_only("var u = 'https://login.live.com/x';"))

    def test_it_drops_line_and_block_comments(self):
        code = code_only(self.SAMPLE)
        self.assertNotIn("a block note", code)
        self.assertNotIn("a line note", code)
        self.assertNotIn("PublicKeyCredential", code)
        self.assertNotIn("navigator.credentials", code)

    def test_a_rewrite_hidden_in_code_is_still_visible(self):
        self.assertIn("navigator.credentials", code_only("navigator.credentials = 1;"))
        self.assertIn("PublicKeyCredential", code_only("delete window.PublicKeyCredential;"))

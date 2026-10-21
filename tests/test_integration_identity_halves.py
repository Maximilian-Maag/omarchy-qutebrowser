"""Integration: the two halves of the stock-Chrome identity cover the same hosts.

The identity is deliberately split in two, and both halves have to name the same hosts, or the
client contradicts itself:

  request half  ``_STOCK_CHROME_HOSTS`` in ``config/config.py``: a Chrome User-Agent (no
                QtWebEngine token), a ``sec-ch-ua`` client hint that says "Google Chrome", a
                readable canvas, no Do-Not-Track, third-party cookies allowed.
  JavaScript half  the Greasemonkey identity scripts: ``navigator.userAgentData.brands`` gains
                "Google Chrome", ``window.chrome`` is populated, ``pdfViewerEnabled`` is true.

A host with the request half but not the JS half sends ``sec-ch-ua: "Google Chrome";v="140"``
while ``navigator.userAgentData.brands`` still says Chromium-only - the header and the page
disagree about what browser this is, which is precisely the inconsistency the identity exists to
remove. ``docs/anti-bot-identity.md`` states the rule ("keep the two in step") but nothing
enforced it, and six patterns had drifted out of coverage; those are pinned below with a reason.

This file also pins the premise the whole design now rests on (see the last test): qutebrowser
stopped advertising the QtWebEngine token in its own default User-Agent, so the per-host UA
override is redundant insurance rather than the mechanism.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "config.py"
USERSCRIPTS = ROOT / "userscripts"

# The host in each key gets the request half but no JavaScript half, on purpose.
ALLOWED_DIVERGENCE = {
    "accounts.youtube.com":
        "SetSID redirect endpoint of the Google sign-in handshake - it renders no page a detector "
        "runs on, and the Google identity script is deliberately held to accounts.google.com/* "
        "by tests/test_regression_signin_untouched.py.",
}

# The Microsoft sign-in hosts keep the request half only: the bot-managed JavaScript identity is
# scoped away from these hosts by tests/test_regression_signin_untouched.py. Open decision, stated
# plainly rather than hidden: either extend the JS half to them, or stop sending a branded
# sec-ch-ua there - right now the header claims Chrome while the page's brands say Chromium.
_MICROSOFT_REASON = (
    "Microsoft sign-in host. The JavaScript half is scoped away from Microsoft hosts by "
    "test_regression_signin_untouched.py, so this host keeps the request half only: the header "
    "claims Google Chrome while navigator.userAgentData.brands does not. Extend the JS half here "
    "or drop the branded sec-ch-ua - do not leave it silently one-sided."
)
for _host in ("account.microsoft.com", "login.live.com", "login.microsoft.com",
              "login.microsoftonline.com"):
    ALLOWED_DIVERGENCE[_host] = _MICROSOFT_REASON


def code_only(text):
    """Strip comments, so a comment *naming* a brand is not read as code that sets it.

    Mirrors tests/test_regression_signin_untouched.py's helper: a URL contains `//` and `/*`, so a
    line comment only starts at a `//` not preceded by a colon, and a block comment only at the
    beginning of a line.
    """
    without_block = re.sub(r"(?m)^[ \t]*/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<!:)//[^\n]*", "", without_block)


def request_half_hosts():
    """The bare hosts named by `_STOCK_CHROME_HOSTS` in config.py (deduplicated)."""
    lines = CONFIG.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("_STOCK_CHROME_HOSTS"))
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == ")")
    body = " ".join(line.split("#")[0] for line in lines[start + 1:end])
    patterns = re.findall(r'"(https://[^"]+)"', body)
    # both `host` and `host/*` are listed per site, and both strip to the same bare host
    return sorted({p.split("//", 1)[1].strip("/").rstrip("*").strip("/") for p in patterns})


def js_half_hosts():
    """The bare hosts the JavaScript identity scripts are scoped to.

    A script belongs to the JS half when its *code* patches `userAgentData` - the same signal
    tests/test_regression_signin_untouched.py uses to decide what needs an explicit exception, so
    a new identity script is picked up here automatically.
    """
    hosts = set()
    for path in sorted(USERSCRIPTS.glob("*.js")):
        code = code_only(path.read_text())
        if "userAgentData" not in code:
            continue
        for pattern in re.findall(r"^//\s*@match\s+(\S+)", path.read_text(), re.M):
            hosts.add(pattern.split("//", 1)[1].strip("/").rstrip("*").strip("/"))
    return hosts


class IdentityHalvesCoverTheSameHosts(unittest.TestCase):
    def setUp(self):
        self.request = request_half_hosts()
        self.js = js_half_hosts()

    def test_the_lists_are_not_empty(self):
        # A parse that silently returns nothing would make every test below pass vacuously.
        self.assertGreater(len(self.request), 5, "parsed no request-half hosts")
        self.assertGreater(len(self.js), 3, "parsed no JavaScript-half hosts")

    def test_every_request_half_host_is_covered_by_the_js_half_or_a_documented_divergence(self):
        uncovered = []
        for host in self.request:
            if host in self.js:
                continue
            if host not in ALLOWED_DIVERGENCE:
                uncovered.append(host)
        self.assertEqual([], uncovered,
                         "these hosts get a Chrome-branded sec-ch-ua but no JavaScript half, so "
                         "the header and navigator.userAgentData disagree about the browser:\n  "
                         + "\n  ".join(uncovered)
                         + "\nAdd the host to the JS half, or list it in ALLOWED_DIVERGENCE with "
                           "the reason it is one-sided.")

    def test_every_divergence_carries_a_reason(self):
        for host, reason in ALLOWED_DIVERGENCE.items():
            self.assertTrue(reason and len(reason) > 20,
                            "%s is excused from the JS half without a reason" % host)
            self.assertIn(host, self.request,
                          "%s is listed as a divergence but is not in the request half" % host)

    def test_no_js_half_host_is_missing_from_the_request_half(self):
        # The reverse drift: patching navigator on a host whose request half was removed would
        # rewrite the page's APIs while the headers still advertise QtWebEngine.
        one_sided = sorted(h for h in self.js if h not in self.request)
        self.assertEqual([], one_sided,
                         "the JavaScript half covers hosts the request half does not:\n  "
                         + "\n  ".join(one_sided))

    def test_the_request_half_still_claims_google_chrome_for_every_host(self):
        # Cheap re-derivation from the same file, so a divergence added above cannot quietly drop
        # the branded hint as well.
        text = CONFIG.read_text()
        self.assertIn('"Google Chrome";v="%s"', text,
                      "the sec-ch-ua builder lost its Google Chrome brand")
        self.assertIn('"sec-ch-ua-platform": \'"Linux"\'', text)


class ThePremiseThisDependsOn(unittest.TestCase):
    """qutebrowser 3.7.0 stopped putting the QtWebEngine token in its own default User-Agent.

    Measured: `content.headers.user_agent`'s installed default template is
    `Mozilla/5.0 ({os_info}) AppleWebKit/{webkit_version} (KHTML, like Gecko)
    {upstream_browser_key}/{upstream_browser_version_short} Safari/{webkit_version}` - no
    `{qt_key}/{qt_version}` - so the browser sends a plain Chrome UA on every host and this
    configuration's per-host UA override is byte-identical to it. The override is kept as
    insurance (it costs nothing and is what protects the hosts if an engine update puts the token
    back); the client hints are what actually does the work now.
    """

    def configdata(self):
        candidates = []
        for base in ("/usr/lib", "/usr/lib64", "/usr/local/lib"):
            candidates += list(pathlib.Path(base).glob(
                "python3*/site-packages/qutebrowser/config/configdata.yml"))
        return candidates[0] if candidates else None

    def test_the_engines_default_ua_no_longer_advertises_qtwebengine(self):
        path = self.configdata()
        if path is None:
            self.skipTest("qutebrowser is not installed here")
        text = path.read_text()
        match = re.search(r"content\.headers\.user_agent:.*?default:\s*'(.*?)'",
                          text, re.S)
        if match is None:
            self.fail("could not read the default User-Agent from %s" % path)
        template = match.group(1)
        # Both placeholders, not just {qt_key}: a template that restored `QtWebEngine/{qt_version}`
        # alone would put the token back without naming the key.
        tokens = [token for token in ("{qt_key}", "{qt_version}") if token in template]
        self.assertEqual(
            [], tokens,
            "qutebrowser's default User-Agent advertises the QtWebEngine token again (%s). The "
            "per-host UA override is now LOAD-BEARING rather than redundant insurance, and the "
            "identity's reasoning in docs/anti-bot-identity.md needs revisiting."
            % ", ".join(tokens)
        )

    def test_our_override_can_never_add_the_token_back(self):
        lines = CONFIG.read_text().splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith("def _stock_chrome_user_agent"))
        body = " ".join(lines[start:start + 12])
        self.assertNotIn("QtWebEngine", body,
                         "the stock UA builder names QtWebEngine - the whole point is that the "
                         "hosts it covers do not advertise it")
        self.assertIn('"Chrome/%s Safari/537.36"', body)


if __name__ == "__main__":
    unittest.main()

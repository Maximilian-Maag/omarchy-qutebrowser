"""Unit tests for bin/ai-fix-overblocking: the JavaScript over-blocking check.

These exercise real behaviour — subresource extraction, first/third-party classification, the
hosts-blocker match, the on-page signatures, the verdict ladder and the end-to-end analyze() —
so a behaviour-changing mutation dies rather than merely being called. The adblock binding
(engine) is only present on the system Python, so its path is skipped, never silently passed,
when it is absent.
"""
import importlib.machinery
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent


def load_tool(name="ai_fix_overblocking_unit"):
    path = REPO / "bin/ai-fix-overblocking"
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod


TOOL = load_tool()


class ReexecArgs(unittest.TestCase):
    def test_none_falls_back_to_the_interpreter_arguments(self):
        self.assertEqual(TOOL._reexec_args(None, ["--flag"]), ["--flag"])

    def test_an_empty_list_also_falls_back(self):
        self.assertEqual(TOOL._reexec_args([], ["--flag"]), ["--flag"])

    def test_an_explicit_argv_is_used_as_is(self):
        self.assertEqual(TOOL._reexec_args(["a", "b"], ["ignored"]), ["a", "b"])

    def test_the_result_is_a_fresh_list(self):
        src = ["a"]
        out = TOOL._reexec_args(src, [])
        out.append("b")
        self.assertEqual(src, ["a"])


class ReexecTarget(unittest.TestCase):
    def test_none_when_already_the_system_interpreter(self):
        self.assertIsNone(TOOL._reexec_target("/usr/bin/python3"))
        self.assertIsNone(TOOL._reexec_target("/usr/bin/python3.14", sys_python="/usr/bin/python3"))
        # A symlink to the target compares equal by REAL path, so no endless re-exec.
        self.assertIsNone(TOOL._reexec_target("/usr/bin/python3", sys_python="/usr/bin/python3"))

    def test_none_when_the_system_interpreter_is_absent(self):
        self.assertIsNone(TOOL._reexec_target("/frob/python", sys_python="/no/such/python"))

    def test_returns_the_target_for_a_different_interpreter(self):
        self.assertEqual(TOOL._reexec_target("/frob/python", sys_python="/usr/bin/python3"),
                         "/usr/bin/python3")

    def test_an_empty_executable_is_treated_as_different(self):
        self.assertEqual(TOOL._reexec_target("", sys_python="/usr/bin/python3"), "/usr/bin/python3")


class Paths(unittest.TestCase):
    def test_blocking_lists_are_our_two_shipped_lists(self):
        names = sorted(p.name for p in TOOL.blocking_lists())
        self.assertEqual(names, ["trackers.txt", "youtube-ads.txt"])
        for path in TOOL.blocking_lists():
            self.assertEqual(path.parent, REPO / "config" / "blocking")

    def test_hosts_cache_path_honours_xdg_data_home(self):
        old = os.environ.get("XDG_DATA_HOME")
        os.environ["XDG_DATA_HOME"] = "/tmp/xdg-probe"
        try:
            self.assertEqual(TOOL.hosts_cache_path(),
                             pathlib.Path("/tmp/xdg-probe/qutebrowser/blocked-hosts"))
        finally:
            if old is None:
                os.environ.pop("XDG_DATA_HOME", None)
            else:
                os.environ["XDG_DATA_HOME"] = old

    def test_hosts_cache_path_defaults_under_home(self):
        old = os.environ.pop("XDG_DATA_HOME", None)
        try:
            self.assertEqual(TOOL.hosts_cache_path(),
                             pathlib.Path.home() / ".local" / "share" / "qutebrowser"
                             / "blocked-hosts")
        finally:
            if old is not None:
                os.environ["XDG_DATA_HOME"] = old


class HostsLoading(unittest.TestCase):
    def test_reads_both_line_shapes_and_ignores_comments_and_blanks(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = pathlib.Path(tmp) / "qutebrowser" / "blocked-hosts"
            cache.parent.mkdir(parents=True)
            cache.write_text("# comment\n\n0.0.0.0 ads.example.com\nplain.example\n")
            old = os.environ.get("XDG_DATA_HOME")
            os.environ["XDG_DATA_HOME"] = tmp
            try:
                hosts = TOOL.load_hosts()
            finally:
                if old is None:
                    os.environ.pop("XDG_DATA_HOME", None)
                else:
                    os.environ["XDG_DATA_HOME"] = old
        self.assertEqual(hosts, {"ads.example.com", "plain.example"})

    def test_a_missing_cache_is_an_empty_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("XDG_DATA_HOME")
            os.environ["XDG_DATA_HOME"] = tmp
            try:
                self.assertEqual(TOOL.load_hosts(), set())
            finally:
                if old is None:
                    os.environ.pop("XDG_DATA_HOME", None)
                else:
                    os.environ["XDG_DATA_HOME"] = old


class HostMatching(unittest.TestCase):
    HOSTS = {"ads.example.com", "tracker.net"}

    def test_exact_host(self):
        self.assertTrue(TOOL.host_blocks(self.HOSTS, "tracker.net"))

    def test_parent_domain_blocks_the_subdomain(self):
        self.assertTrue(TOOL.host_blocks(self.HOSTS, "cdn.tracker.net"))

    def test_unrelated_host_is_allowed(self):
        self.assertFalse(TOOL.host_blocks(self.HOSTS, "example.org"))

    def test_case_is_folded(self):
        self.assertTrue(TOOL.host_blocks(self.HOSTS, "Tracker.NET"))

    def test_empty_hostname_or_list_is_never_blocked(self):
        self.assertFalse(TOOL.host_blocks(self.HOSTS, ""))
        self.assertFalse(TOOL.host_blocks(set(), "tracker.net"))

    def test_a_suffix_that_is_not_a_domain_boundary_does_not_match(self):
        # "nottracker.net" must not match "tracker.net" by naive substring.
        self.assertFalse(TOOL.host_blocks(self.HOSTS, "nottracker.net"))


class SameSite(unittest.TestCase):
    def test_same_last_two_labels(self):
        self.assertTrue(TOOL.same_site("www.example.com", "cdn.example.com"))
        self.assertTrue(TOOL.same_site("example.com", "example.com"))

    def test_different_sites(self):
        self.assertFalse(TOOL.same_site("example.com", "example.org"))

    def test_empty_is_not_same_site(self):
        self.assertFalse(TOOL.same_site("", "example.com"))
        self.assertFalse(TOOL.same_site("example.com", ""))

    def test_registrable_strips_port_and_lowercases(self):
        self.assertEqual(TOOL.registrable("https://WWW.Example.com:8443/x"), "www.example.com")


class Extraction(unittest.TestCase):
    BASE = "https://www.shop.example/"

    def test_collects_script_link_iframe_fetch_and_xhr(self):
        html = (
            '<script src="/app.js"></script>'
            '<link rel="stylesheet" href="https://cdn.example/style.css">'
            '<iframe src="https://challenge.example/frame"></iframe>'
            '<script>fetch("/api/data");new XMLHttpRequest().open("GET", "/api/x");'
            'import("/mod.js");</script>'
        )
        urls = {s["url"]: s for s in TOOL.extract_subresources(html, self.BASE)}
        self.assertIn("https://www.shop.example/app.js", urls)
        self.assertIn("https://cdn.example/style.css", urls)
        self.assertIn("https://challenge.example/frame", urls)
        self.assertIn("https://www.shop.example/api/data", urls)
        self.assertIn("https://www.shop.example/api/x", urls)
        self.assertIn("https://www.shop.example/mod.js", urls)
        self.assertEqual(urls["https://www.shop.example/app.js"]["kind"], "script")
        self.assertEqual(urls["https://www.shop.example/api/data"]["kind"], "fetch")

    def test_classifies_party_by_registrable_domain(self):
        html = ('<script src="https://cdn.shop.example/a.js"></script>'
                '<script src="https://third.net/b.js"></script>')
        by_url = {s["url"]: s["party"] for s in TOOL.extract_subresources(html, self.BASE)}
        self.assertEqual(by_url["https://cdn.shop.example/a.js"], "first")
        self.assertEqual(by_url["https://third.net/b.js"], "third")

    def test_skips_non_http_and_empty(self):
        html = ('<script src="data:text/javascript,1"></script>'
                '<script src="javascript:void(0)"></script>'
                '<script src=""></script>'
                '<script src="   "></script>')
        self.assertEqual(TOOL.extract_subresources(html, self.BASE), [])

    def test_skips_the_page_itself(self):
        html = '<link rel="canonical" href="https://www.shop.example/">'
        self.assertEqual(TOOL.extract_subresources(html, self.BASE), [])

    def test_deduplicates(self):
        html = '<script src="/a.js"></script><script src="/a.js"></script>'
        self.assertEqual(len(TOOL.extract_subresources(html, self.BASE)), 1)

    def test_accepts_empty_html(self):
        self.assertEqual(TOOL.extract_subresources("", self.BASE), [])
        self.assertEqual(TOOL.extract_subresources(None, self.BASE), [])


class Signals(unittest.TestCase):
    def test_data_dome_marker(self):
        self.assertIn("bot challenge (DataDome)",
                      TOOL.page_signals("var dd={host:'geo.captcha-delivery.com'}"))

    def test_cloudflare_marker(self):
        self.assertIn("bot challenge (Cloudflare)",
                      TOOL.page_signals("<title>Just a moment...</title>"))

    def test_linkedin_block_wording(self):
        self.assertIn("bot challenge (DataDome)",
                      TOOL.page_signals("We detected unusual activity from your device or network"))

    def test_anti_adblock_wall_en(self):
        self.assertIn("anti-adblock wall", TOOL.page_signals("Please disable your ad blocker"))

    def test_anti_adblock_wall_de(self):
        self.assertIn("anti-adblock wall", TOOL.page_signals("Bitte deaktiviere deinen Adblocker"))

    def test_a_clean_page_has_no_signals(self):
        self.assertEqual(TOOL.page_signals("<html><body>hello</body></html>"), [])

    def test_signals_are_not_duplicated(self):
        text = "captcha-delivery.com and datadome and unusual activity from your device"
        self.assertEqual(TOOL.page_signals(text).count("bot challenge (DataDome)"), 1)

    def test_none_html_is_empty(self):
        self.assertEqual(TOOL.page_signals(None), [])


class Verdict(unittest.TestCase):
    def test_bot_challenge_wins(self):
        self.assertIn("bot-challenge", TOOL.verdict_for([], ["bot challenge (DataDome)"]))

    def test_first_party_blocked_is_over_blocking(self):
        blocked = [{"party": "first", "url": "u"}]
        self.assertIn("over-blocking", TOOL.verdict_for(blocked, []))

    def test_third_party_only_is_softer(self):
        blocked = [{"party": "third", "url": "u"}]
        self.assertIn("some page resources", TOOL.verdict_for(blocked, []))

    def test_wall_without_blocked_resources_is_named(self):
        self.assertIn("anti-adblock wall", TOOL.verdict_for([], ["anti-adblock wall"]))

    def test_clean_page(self):
        self.assertIn("clean", TOOL.verdict_for([], []))


class Analyze(unittest.TestCase):
    BASE = "https://www.shop.example/"

    def test_flags_a_first_party_resource_dropped_by_hosts(self):
        html = '<script src="https://track.shop.example/a.js"></script>'
        result = TOOL.analyze(html, self.BASE, engine=None, hosts={"track.shop.example"})
        self.assertEqual(result["checked"], 1)
        self.assertEqual(result["blocked_count"], 1)
        self.assertEqual(result["first_party_blocked"], 1)
        self.assertEqual(result["blocked"][0]["by"], "hosts")
        self.assertIn("over-blocking", result["verdict"])

    def test_a_page_with_nothing_blocked_is_clean(self):
        html = '<script src="/app.js"></script>'
        result = TOOL.analyze(html, self.BASE, engine=None, hosts={"ads.other.net"})
        self.assertEqual(result["blocked_count"], 0)
        self.assertIn("clean", result["verdict"])

    def test_a_bot_challenge_page_is_not_blamed_on_blocking(self):
        html = '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>'
        result = TOOL.analyze(html, self.BASE, engine=None, hosts=set())
        self.assertIn("bot-challenge", result["verdict"])

    def test_hosts_default_to_empty(self):
        result = TOOL.analyze('<script src="/a.js"></script>', self.BASE, engine=None)
        self.assertEqual(result["blocked_count"], 0)

    def test_the_adblock_engine_is_consulted_for_non_host_blocked_urls(self):
        # A fake engine exercises the engine branch without the adblock binding, so these mutants
        # die even on a runner that does not ship python-adblock.
        html = '<script src="https://metrics.other.net/m.js"></script>'
        engine = _FakeEngine(blocked_hosts={"metrics.other.net"})
        result = TOOL.analyze(html, self.BASE, engine=engine, hosts=set())
        self.assertEqual(result["blocked_count"], 1)
        self.assertEqual(result["blocked"][0]["by"], "our-list")
        self.assertEqual(engine.calls[0][0], "https://metrics.other.net/m.js")

    def test_the_engine_uses_the_resource_type_per_kind(self):
        html = ('<script src="https://a.other.net/s.js"></script>'
                '<link rel="stylesheet" href="https://a.other.net/c.css">'
                '<iframe src="https://a.other.net/f.html"></iframe>')
        engine = _FakeEngine(blocked_hosts=set())
        TOOL.analyze(html, self.BASE, engine=engine, hosts=set())
        types = {url: t for url, _src, t in engine.calls}
        self.assertEqual(types["https://a.other.net/s.js"], "script")
        self.assertEqual(types["https://a.other.net/c.css"], "stylesheet")
        self.assertEqual(types["https://a.other.net/f.html"], "subdocument")

    def test_the_real_engine_blocks_google_analytics(self):
        engine = TOOL.load_engine()
        if engine is None:
            self.skipTest("adblock binding absent (system Python only)")
        html = '<script src="https://www.google-analytics.com/analytics.js"></script>'
        result = TOOL.analyze(html, self.BASE, engine=engine, hosts=set())
        self.assertEqual(result["blocked_count"], 1, "our tracker list must block GA")
        self.assertEqual(result["blocked"][0]["by"], "our-list")


class _Result:
    def __init__(self, matched, exception=None):
        self.matched = matched
        self.exception = exception


class _FakeEngine:
    """A stand-in for Brave's engine: blocks anything whose host is in `blocked_hosts`."""

    def __init__(self, blocked_hosts):
        self.blocked_hosts = set(blocked_hosts)
        self.calls = []

    def check_network_urls(self, url, source, rtype):
        self.calls.append((url, source, rtype))
        host = TOOL.registrable(url)
        matched = host in self.blocked_hosts
        return _Result(matched, exception=None if matched else None)


class EngineBlocks(unittest.TestCase):
    BASE = "https://www.shop.example/"

    def test_true_when_matched_without_exception(self):
        engine = _FakeEngine({"a.other.net"})
        self.assertTrue(TOOL.engine_blocks(engine, "https://a.other.net/s.js", self.BASE, "script"))

    def test_false_when_not_matched(self):
        engine = _FakeEngine(set())
        self.assertFalse(TOOL.engine_blocks(engine, "https://a.other.net/s.js", self.BASE, "script"))

    def test_false_when_an_exception_wins(self):
        # An `@@` allow rule sets exception while matched stays true - that must read as allowed.
        engine = _FakeEngine({"a.other.net"})

        class _Allowed(_FakeEngine):
            def check_network_urls(self, url, source, rtype):
                return _Result(True, exception="@@")

        self.assertFalse(TOOL.engine_blocks(_Allowed(set()), "https://a.other.net/s.js",
                                            self.BASE, "script"))

    def test_passes_the_url_source_and_type_through(self):
        engine = _FakeEngine(set())
        TOOL.engine_blocks(engine, "https://a.other.net/s.js", self.BASE, "image")
        self.assertEqual(engine.calls[0], ("https://a.other.net/s.js", self.BASE, "image"))


if __name__ == "__main__":
    unittest.main()

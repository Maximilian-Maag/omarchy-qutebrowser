"""Unit tests for bin/reader-server: pure helpers and the AI plumbing.

These exercise real behaviour — the build stamp, state-key derivation, the AI
concurrency bound, the model runner, the news-RSS parser, the paragraph batcher,
the whole-article fact checker and the /ai mode dispatch — so a behaviour-changing
mutation dies rather than merely being called.
"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent


def load_server(name="reader_server_unit"):
    path = REPO / "bin/reader-server"
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod


class ConstantsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_consts")

    def test_build_stamp_is_12_hex_chars(self):
        self.assertEqual(len(self.srv.BUILD), 12)
        int(self.srv.BUILD, 16)          # must be hexadecimal

    def test_state_key_is_16_hex_chars(self):
        key = self.srv._state_key("https://example.com/article?id=1")
        self.assertEqual(len(key), 16)
        int(key, 16)

    def test_state_key_is_stable_and_url_specific(self):
        self.assertEqual(self.srv._state_key("a"), self.srv._state_key("a"))
        self.assertNotEqual(self.srv._state_key("a"), self.srv._state_key("b"))

    def test_ai_concurrency_is_bounded_to_two(self):
        # A third simultaneous model call must be refused without blocking — the
        # whole point of the BoundedSemaphore.
        slots = self.srv._AI_SLOTS
        got = [slots.acquire(blocking=False), slots.acquire(blocking=False)]
        try:
            self.assertEqual(got, [True, True])
            self.assertFalse(slots.acquire(blocking=False),
                             "only two model calls may run at once")
        finally:
            for ok in got:
                if ok:
                    slots.release()

    def test_state_dir_falls_back_to_home_when_env_unset(self):
        # STATE_DIR = Path(os.environ.get("XDG_STATE_HOME") or home/.local/state)/…
        # With the env var unset the `or` must pick the home path.
        saved = os.environ.pop("XDG_STATE_HOME", None)
        try:
            srv = load_server("reader_server_statedir")
            parts = srv.STATE_DIR.parts
            self.assertIn(".local", parts)
            self.assertIn("state", parts)
            self.assertEqual(parts[-2:], ("omarchy-qutebrowser", "reader"))
        finally:
            if saved is not None:
                os.environ["XDG_STATE_HOME"] = saved


class ThemeColorsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_theme")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = pathlib.Path(self.tmp.name)
        self.saved = (self.srv.STATE_DIR, os.environ.get("HOME"))
        self.addCleanup(lambda: (setattr(self.srv, "STATE_DIR", self.saved[0]),
                                 os.environ.update({"HOME": self.saved[1]})
                                 if self.saved[1] is not None else os.environ.pop("HOME", None)))
        # STATE_DIR.parent holds exactly one file: active-theme
        self.srv.STATE_DIR = root / "state" / "reader"
        os.environ["HOME"] = str(root)
        self.themes = root / ".config" / "omarchy" / "themes"
        self.themes.mkdir(parents=True)
        self.active = root / "state" / "active-theme"
        self.active.parent.mkdir(parents=True, exist_ok=True)

    def test_empty_active_theme_falls_back_to_defaults(self):
        # A probe file sitting where "" would resolve must NOT be picked up.
        (self.themes / "colors.toml").write_text('mode = "dark"\naccent = "#abcdef"\n')
        self.active.write_text("")
        colors = self.srv.theme_colors()
        self.assertNotEqual(colors["accent"], "#abcdef",
                            "an empty theme name must use the fallback, not themes/colors.toml")
        self.assertEqual(colors["accent"], "#82FB9C")

    def test_named_theme_is_loaded(self):
        theme = self.themes / "MyTheme"
        theme.mkdir()
        (theme / "colors.toml").write_text('mode = "dark"\naccent = "#0f0f0f"\n')
        self.active.write_text("MyTheme\n")
        self.assertEqual(self.srv.theme_colors()["accent"], "#0f0f0f")


class ExtractJsonCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_json")

    def test_object_embedded_in_prose_is_extracted(self):
        self.assertEqual(self.srv.extract_json('pre {"a": 1} post'), {"a": 1})

    def test_array_embedded_in_prose_is_extracted(self):
        self.assertEqual(self.srv.extract_json("junk [1, 2, 3] tail"), [1, 2, 3])

    def test_fenced_json_is_unwrapped(self):
        self.assertEqual(self.srv.extract_json('```json\n{"k": "v"}\n```'), {"k": "v"})

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            self.srv.extract_json("nothing here")


class RunAiCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_runai")

    def setUp(self):
        self.saved_popen = self.srv.subprocess.Popen
        self.saved_timeout = self.srv.AI_TIMEOUT
        self.addCleanup(self._restore)
        self.calls = []

        class FakePopen:
            rc = 0
            out = '{"ok": true}'
            err = ""
            last = None

            def __init__(self, args, **kw):
                FakePopen.last = self
                self.args, self.kw = args, kw
                self.returncode = FakePopen.rc
                self.timeout = None

            def communicate(self, timeout=None):
                self.timeout = timeout
                return FakePopen.out, FakePopen.err

        self.fake = FakePopen
        self.srv.subprocess.Popen = FakePopen
        self.addCleanup(lambda: setattr(self.srv.subprocess, "Popen", self.saved_popen))

    def _restore(self):
        self.srv.AI_TIMEOUT = self.saved_timeout

    def test_invokes_hermes_in_cli_mode_and_parses_output(self):
        result = self.srv.run_ai("PROMPT")
        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.fake.last.args, [self.srv.HERMES, "-z", "PROMPT", "--cli"])
        self.assertIs(self.fake.last.kw.get("start_new_session"), True,
                      "the child must lead its own session so a timeout can kill the group")
        self.assertIs(self.fake.last.kw.get("text"), True)
        self.assertEqual(self.fake.last.kw.get("stdout"), self.srv.subprocess.PIPE)

    def test_explicit_timeout_overrides_the_default(self):
        self.srv.AI_TIMEOUT = 999
        self.srv.run_ai("PROMPT", timeout=5)
        self.assertEqual(self.fake.last.timeout, 5)

    def test_nonzero_exit_raises_with_a_message(self):
        self.fake.rc = 1
        self.fake.err = ""
        with self.assertRaises(RuntimeError) as ctx:
            self.srv.run_ai("PROMPT")
        self.assertIn("hermes failed", str(ctx.exception),
                      "an empty stderr must still yield a meaningful error")

    def test_stderr_is_surfaced_on_failure(self):
        self.fake.rc = 1
        self.fake.err = "boom: no model"
        with self.assertRaises(RuntimeError) as ctx:
            self.srv.run_ai("PROMPT")
        self.assertIn("boom", str(ctx.exception))


class NewsQueryCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_newsq")

    def test_distinctive_words_are_kept(self):
        q = self.srv.news_query("The council approved the Riverside Bridge project funding today")
        self.assertTrue(q, "a real paragraph must produce a query")
        self.assertIn("Riverside", q)
        self.assertNotIn("the", q.split())

    def test_query_is_capped_at_eight_words(self):
        words = ["Alpha%d" % i for i in range(20)]
        q = self.srv.news_query(" ".join(words))
        self.assertEqual(len(q.split()), 8)

    def test_empty_text_yields_empty_query(self):
        self.assertEqual(self.srv.news_query(""), "")


class NewsSearchCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_news")

    RSS = """<?xml version="1.0"?><rss><channel>
      <item><title>Story One - CNN</title><link>http://a</link><source>CNN</source></item>
      <item><title>Market Update</title><link>http://b</link><source>Reuters</source></item>
      <item><title>Story Two - Reuters</title><link>http://c</link></item>
      <item><title>Big - Story</title><link>http://d</link><source>CNN</source></item>
      <item><title>Plain Headline</title><link>http://e</link></item>
    </channel></rss>"""

    def setUp(self):
        self.saved = self.srv.urllib.request.urlopen

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return NewsSearchCase.RSS.encode()

        self.srv.urllib.request.urlopen = lambda req, timeout=None: FakeResponse()
        self.addCleanup(lambda: setattr(self.srv.urllib.request, "urlopen", self.saved))

    def by_link(self):
        return {h["url"]: h for h in self.srv.news_search("query", "en")}

    def test_source_element_is_used_to_split_headline(self):
        h = self.by_link()["http://a"]
        self.assertEqual(h["headline"], "Story One")
        self.assertEqual(h["source"], "CNN")

    def test_source_survives_a_title_without_a_separator(self):
        h = self.by_link()["http://b"]
        self.assertEqual(h["headline"], "Market Update")
        self.assertEqual(h["source"], "Reuters",
                         "a <source> element must yield the outlet even with no ' - ' suffix")

    def test_missing_source_splits_on_the_dash(self):
        h = self.by_link()["http://c"]
        self.assertEqual(h["headline"], "Story Two")
        self.assertEqual(h["source"], "Reuters")

    def test_title_not_ending_in_source_is_left_whole(self):
        h = self.by_link()["http://d"]
        self.assertEqual(h["headline"], "Big - Story")
        self.assertEqual(h["source"], "CNN")

    def test_item_without_source_and_without_dash(self):
        h = self.by_link()["http://e"]
        self.assertEqual(h["headline"], "Plain Headline")
        self.assertEqual(h["source"], "")


class ParagraphBatchesCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_batches")

    def test_paragraphs_split_when_the_budget_is_exceeded(self):
        paras = ["x" * 20, "y" * 20]
        batches = list(self.srv._paragraph_batches(paras, budget=50))
        self.assertEqual(len(batches), 2, "each ~32-char batch must not fit two in 50")
        self.assertEqual(batches[0], [(0, paras[0])])
        self.assertEqual(batches[1], [(1, paras[1])])

    def test_batches_that_exactly_fill_the_budget_stay_together(self):
        paras = ["x" * 20, "y" * 20]
        batches = list(self.srv._paragraph_batches(paras, budget=64))
        self.assertEqual(len(batches), 1, "64 == 32+32 must not split")

    def test_one_oversized_paragraph_yields_exactly_one_batch(self):
        paras = ["z" * 100]
        batches = list(self.srv._paragraph_batches(paras, budget=50))
        self.assertEqual(len(batches), 1, "an over-budget single paragraph is still one batch")
        self.assertEqual(batches[0], [(0, paras[0])])

    def test_no_paragraphs_yields_no_batches(self):
        self.assertEqual(list(self.srv._paragraph_batches([])), [])


class FactCheckArticleCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_fca")

    def setUp(self):
        self.saved = self.srv.news_search
        self.addCleanup(lambda: setattr(self.srv, "news_search", self.saved))
        self.srv.news_search = lambda query, lang: []

    def test_paragraph_at_exactly_the_minimum_length_is_checked(self):
        self.srv.run_ai = lambda prompt: []
        out = self.srv.fact_check_article(["a" * 20])
        self.assertEqual(len(out), 1, "a 20-char paragraph meets min_len=20")

    def test_model_returning_extra_entries_does_not_crash(self):
        def model(prompt):
            return [{"index": 0, "verdict": "supported"},
                    {"index": 999, "verdict": "supported"}]
        self.srv.run_ai = model
        out = self.srv.fact_check_article(["A paragraph that is definitely long enough."])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["index"], 0)


class AiAnswerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_aianswer")

    def setUp(self):
        self.saved = self.srv.run_ai
        self.addCleanup(lambda: setattr(self.srv, "run_ai", self.saved))

    def test_paragraph_mode_uses_paragraph_prompt(self):
        seen = {}

        def model(prompt):
            seen["p"] = prompt
            return {"ai_likelihood": 10}
        self.srv.run_ai = model
        self.assertEqual(self.srv.ai_answer({"mode": "paragraph", "text": "Hello there"}),
                         {"ai_likelihood": 10})
        self.assertIn("Hello there", seen["p"])

    def test_summary_mode_is_dispatched(self):
        self.srv.run_ai = lambda prompt: {"summary": ["one"], "verdict": "human"}
        out = self.srv.ai_answer({"mode": "summary", "text": "Article body here."})
        self.assertEqual(out["summary"], ["one"])

    def test_article_marks_mode_is_dispatched(self):
        self.srv.run_ai = lambda prompt: [{"index": 0, "verdict": "human"}]
        out = self.srv.ai_answer({"mode": "article_marks", "paragraphs": ["A para."]})
        self.assertEqual(out, [{"index": 0, "verdict": "human"}])

    def test_article_marks_global_indices_are_not_swapped(self):
        # The model answers with the two paragraph indices in reverse order; each
        # result must keep the index (and payload) it actually belongs to.
        def model(prompt):
            return [{"index": 1, "mark": "A"}, {"index": 0, "mark": "B"}]
        self.srv.run_ai = model
        out = self.srv.ai_answer({"mode": "article_marks", "paragraphs": ["p0", "p1"]})
        self.assertEqual([o["index"] for o in out], [0, 1])
        self.assertEqual(out[0]["mark"], "B")
        self.assertEqual(out[1]["mark"], "A")

    def test_article_marks_ignores_extra_model_entries(self):
        def model(prompt):
            return [{"index": 0, "mark": "A"}, {"index": 999, "mark": "X"}]
        self.srv.run_ai = model
        out = self.srv.ai_answer({"mode": "article_marks", "paragraphs": ["only one"]})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["index"], 0)

    def test_unknown_mode_raises(self):
        with self.assertRaises(ValueError):
            self.srv.ai_answer({"mode": "nope"})


class CoverageCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_coverage")

    def setUp(self):
        self.saved = self.srv.news_search
        self.addCleanup(lambda: setattr(self.srv, "news_search", self.saved))

    def test_outlets_are_capped_at_twenty_four(self):
        self.srv.news_search = lambda query, lang: [
            {"headline": "Headline %d" % i, "source": "Outlet %d" % i, "url": "u%d" % i}
            for i in range(30)]
        res = self.srv.coverage_for("A headline with enough distinctive words here")
        self.assertEqual(res["total"], 24)
        self.assertEqual(len(res["outlets"]), 24)


class PublisherTieBreakCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server("reader_server_pubs")

    def test_equal_length_domains_keep_the_first_entry(self):
        # "longest match wins" is a strict comparison: two matching entries of equal
        # length must not let the later one silently replace the earlier.
        saved = self.srv.publishers
        self.addCleanup(lambda: setattr(self.srv, "publishers", saved))
        self.srv.publishers = lambda: {"publishers": [
            {"domain": "a.com", "name": "First", "lean": "left"},
            {"domain": "a.com", "name": "Second", "lean": "right"}], "agencies": []}
        prof = self.srv.publisher_for("a.com")
        self.assertIsNotNone(prof)
        self.assertEqual(prof["name"], "First")


class MainPruneCase(unittest.TestCase):
    def test_article_with_mtime_equal_to_cutoff_is_kept(self):
        # main() prunes articles older than 24h with `mtime < cutoff`; a file whose
        # mtime is exactly the cutoff (a <= mutant) must survive.
        srv = load_server("reader_server_main")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        saved = {k: getattr(srv, k) for k in
                 ("STATE_DIR", "ARTICLES_DIR", "STATE_STORE", "SERVER_JSON")}
        srv.STATE_DIR = root / "state"
        srv.ARTICLES_DIR = root / "state" / "articles"
        srv.STATE_STORE = root / "state" / "article-state"
        srv.SERVER_JSON = root / "state" / "server.json"
        srv.ARTICLES_DIR.mkdir(parents=True)
        srv.STATE_STORE.mkdir(parents=True)

        now = 1_700_000_000.0
        cutoff = now - 24 * 3600
        edge = srv.ARTICLES_DIR / "edge"
        old = srv.ARTICLES_DIR / "old"
        new = srv.ARTICLES_DIR / "new"
        for path, when in ((edge, cutoff), (old, cutoff - 10), (new, now)):
            path.write_text("x")
            os.utime(path, (when, when))

        class FakeHTTPD:
            def __init__(self, addr, handler):
                self.server_address = ("127.0.0.1", 9)
                self.handler = handler

            def serve_forever(self):
                return None

        saved_server = srv.ThreadingHTTPServer
        saved_time = srv.time
        srv.ThreadingHTTPServer = FakeHTTPD
        srv.time = types.SimpleNamespace(time=lambda: now)
        try:
            srv.main()
        finally:
            srv.ThreadingHTTPServer = saved_server
            srv.time = saved_time
            for k, v in saved.items():
                setattr(srv, k, v)

        self.assertTrue(edge.exists(), "mtime == cutoff must be kept (< not <=)")
        self.assertTrue(new.exists())
        self.assertFalse(old.exists(), "genuinely old articles are still pruned")


if __name__ == "__main__":
    unittest.main()

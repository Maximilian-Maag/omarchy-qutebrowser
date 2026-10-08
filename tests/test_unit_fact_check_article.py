"""Unit tests: every paragraph of an article gets fact-checked.

The bug this pins: `fact_check_article` had a hard `max_paras=12` cap and asked the
model to cover the whole article in one prompt, so "fact-check the article" quietly
checked an unpredictable subset. Both are gone; what must hold now is that EVERY
paragraph over the threshold comes back with an entry — either a verdict or a stated
reason — no matter how many there are or how unhelpfully the model answers.
"""
import importlib.machinery
import importlib.util
import pathlib
import sys
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent


def load_server():
    path = REPO / "bin/reader-server"
    loader = importlib.machinery.SourceFileLoader("reader_server_fc", str(path))
    spec = importlib.util.spec_from_loader("reader_server_fc", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reader_server_fc"] = mod
    loader.exec_module(mod)
    return mod


class FactCheckAllParagraphsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server()

    def setUp(self):
        self.saved = (self.srv.news_search, self.srv.run_ai)
        self.addCleanup(lambda: (setattr(self.srv, "news_search", self.saved[0]),
                                 setattr(self.srv, "run_ai", self.saved[1])))
        self.srv.news_search = lambda query, lang: []

    def stub_model(self, fn):
        self.srv.run_ai = fn

    def paragraphs(self, n):
        return ["Paragraph number %d with plenty of words in it to be checked." % i
                for i in range(n)]

    @staticmethod
    def answering(prompt):
        """Answer for exactly the paragraphs this prompt contains — what a real model does."""
        idxs = []
        for line in prompt.splitlines():
            head = line.strip().split(".", 1)[0]
            if head.isdigit():
                idxs.append(int(head))
        return [{"index": i, "verdict": "supported"} for i in idxs]

    def test_every_paragraph_over_the_threshold_is_covered(self):
        self.stub_model(self.answering)
        out = self.srv.fact_check_article(self.paragraphs(20))
        indexes = [o["index"] for o in out]
        self.assertEqual(indexes, list(range(20)),
                         "all 20 paragraphs must come back, not the first 12")
        self.assertEqual(len(indexes), len(set(indexes)), "no paragraph reported twice")

    def test_a_cap_no_longer_exists(self):
        # 40 real paragraphs, a model that answers perfectly every time
        self.stub_model(self.answering)
        out = self.srv.fact_check_article(self.paragraphs(40))
        self.assertEqual(len(out), 40, "40 paragraphs in, 40 verdicts out")
        self.assertEqual([o["index"] for o in out], sorted(o["index"] for o in out),
                         "results come back in document order")

    def test_a_paragraph_the_model_skips_is_reported_not_dropped(self):
        self.stub_model(lambda prompt: [{"index": 0, "verdict": "supported"}])
        out = self.srv.fact_check_article(self.paragraphs(6))
        indexes = [o["index"] for o in out]
        self.assertEqual(indexes, list(range(6)), "nothing may vanish: %s" % indexes)
        missing = [o for o in out if o.get("verdict") == "unclear"]
        self.assertEqual(len(missing), 5)
        self.assertIn("no verdict", missing[0]["note"])

    def test_fragments_below_the_threshold_are_not_sent_to_the_model(self):
        seen = []
        self.stub_model(lambda prompt: seen.append(prompt) or [])
        out = self.srv.fact_check_article(["Short.", "A real paragraph long enough to check."])
        self.assertEqual(len(out), 1)
        self.assertNotIn("Short.", seen[0] if seen else "")

    def test_nothing_checkable_is_an_error(self):
        with self.assertRaises(ValueError):
            self.srv.fact_check_article(["a", "b", ""])


if __name__ == "__main__":
    unittest.main()

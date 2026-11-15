"""Regression: every `reader-*` alias that calls jseval must run in the MAIN world.

reader/reader.js is loaded as a page <script>, so it defines `window.omarchyReader` in the
MAIN world. qutebrowser's `jseval` defaults to an isolated world, where that global is
invisible: each alias's `if (r) { ... }` guard is falsy and the command silently does
nothing. The `--world=main` flag puts the call back in the same world as the object it
drives. config.py is data (option/alias assignments), so this asserts on the source text
rather than executing it.
"""
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
CONFIG = REPO / "config" / "config.py"

# One alias line: `    'name': 'value',`
_ALIAS_LINE = re.compile(r"^\s*'([^']+)':\s*'(.*)',\s*$", re.M)


def jseval_aliases_without_main_world(text):
    """Names of aliases whose value runs jseval but never selects the main world."""
    offenders = []
    for name, value in _ALIAS_LINE.findall(text):
        if "jseval" not in value:
            continue
        if "--world=main" not in value:
            offenders.append(name)
    return offenders


def jseval_alias_count(text):
    return sum(1 for _, value in _ALIAS_LINE.findall(text) if "jseval" in value)


class ReaderAliasWorldCase(unittest.TestCase):
    def setUp(self):
        self.text = CONFIG.read_text()

    def test_no_jseval_alias_runs_in_the_isolated_world(self):
        offenders = jseval_aliases_without_main_world(self.text)
        self.assertEqual(
            offenders, [],
            "reader/reader.js lives in the MAIN world, so these reader bindings would "
            "silently no-op without --world=main: %r" % (offenders,))

    def test_the_reader_aliases_actually_exist(self):
        # Guard the guard: if the alias parsing ever stopped matching, the test above
        # would pass vacuously.
        self.assertGreaterEqual(jseval_alias_count(self.text), 10,
                                "expected the reader-* jseval aliases to be present")

    def test_the_old_source_would_have_failed(self):
        # The exact buggy form (no --world=main) must be caught by the checker.
        bad = "    'reader-next': 'jseval -q (function(){var r=window.omarchyReader;})()',\n"
        self.assertEqual(jseval_aliases_without_main_world(bad), ["reader-next"])


if __name__ == "__main__":
    unittest.main()

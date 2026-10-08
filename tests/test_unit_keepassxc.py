"""Unit tests: qute-keepassxc-fill's pure logic.

The userscript cannot be imported as a module — it has a top-level dependency guard
that calls sys.exit() under an interpreter without PyNaCl — so the declarations we
need are pulled out of its AST and exec'd. That still tests the shipped source.
"""
import ast
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
US = REPO / "userscripts/qute-keepassxc-fill"


def load_userscript():
    mod = types.SimpleNamespace()
    tree = ast.parse(US.read_text())
    keep = (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign,
            ast.FunctionDef, ast.ClassDef)
    body = [n for n in tree.body if isinstance(n, keep)]
    exec(compile(ast.Module(body=body, type_ignores=[]), str(US), "exec"), mod.__dict__)
    return mod


class UserscriptCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.us = load_userscript()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env = {k: os.environ.get(k) for k in ("XDG_STATE_HOME", "QUTE_FIFO")}
        os.environ["XDG_STATE_HOME"] = self.tmp.name
        fifo = pathlib.Path(self.tmp.name) / "fifo"
        fifo.write_text("")
        os.environ["QUTE_FIFO"] = str(fifo)
        self.fifo = fifo

    def tearDown(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # ── one_line: the FIFO takes ONE command per line ──────────────────────
    def test_one_line_collapses_to_a_single_line(self):
        out = self.us.one_line("var a = 1;\nvar b = 2;\nreturn a + b;")
        self.assertNotIn("\n", out)
        self.assertIn("var b = 2;", out)

    def test_one_line_strips_comments(self):
        out = self.us.one_line("var a = 1; // trailing\n/* block */ var b = 2;")
        self.assertNotIn("trailing", out)
        self.assertNotIn("block", out)

    def test_one_line_keeps_spaces_inside_strings(self):
        out = self.us.one_line('var pw = "two  spaces";')
        self.assertIn('"two  spaces"', out)

    def test_one_line_keeps_regex_literals_intact(self):
        # A regression guard: collapsing must not treat a regex as a comment.
        js = "var re = /hidden|decoy/i; var t = x.replace(/\\s+/g, ' ');"
        out = self.us.one_line(js)
        self.assertIn("/hidden|decoy/i", out)
        self.assertIn("/\\s+/g", out)

    # ── the fill template ─────────────────────────────────────────────────
    def test_fill_js_targets_the_two_step_login_buttons(self):
        js = self.us.fill_js("user@example.com", "secret")
        for needle in ("identifierNext", "passwordNext", "idSIButton9"):
            self.assertIn(needle, js)
        self.assertIn("pointerdown", js)          # full pointer sequence, not .click()

    def test_fill_js_never_submits_a_registration_form(self):
        js = self.us.fill_js("u", "p")
        self.assertIn("regist", js)               # /creat|regist|cadastr|sign ?up/…
        self.assertIn("konto", js)                # … plus the German "Konto erstellen"

    def test_fill_js_ignores_decoy_fields(self):
        js = self.us.fill_js("u", "p")
        self.assertIn("hidden|decoy", js)

    def test_fill_js_escapes_user_and_password(self):
        js = self.us.fill_js('a"b', "p\\w")
        self.assertIn(json.dumps('a"b'), js)

    def test_fill_only_does_not_press_anything(self):
        self.assertIn("ADVANCE = false", self.us.fill_js("u", "p", advance=False))
        self.assertIn("ADVANCE = true", self.us.fill_js("u", "p"))

    # ── account selection ─────────────────────────────────────────────────
    def creds(self):
        return [
            {"name": "Personal", "login": "me@example.com", "uuid": "aaaa1111", "group": "Private"},
            {"name": "Work", "login": "me@corp.example", "uuid": "bbbb2222", "group": "Work"},
            {"name": "Shop", "login": "shopping@example.com", "uuid": "cccc3333"},
        ]

    def test_labels_disambiguate_by_group(self):
        label = self.us.account_label(self.creds()[0], 0)
        self.assertTrue(label.startswith("1\t"), label)
        self.assertIn("Private", label)
        self.assertIn("Personal", label)
        self.assertIn("me@example.com", label)

    def test_match_by_number_login_uuid_and_title(self):
        creds = self.creds()
        self.assertEqual(self.us.match_index(creds, "2"), 1)
        self.assertEqual(self.us.match_index(creds, "me@corp.example"), 1)
        self.assertEqual(self.us.match_index(creds, "cccc"), 2)
        self.assertEqual(self.us.match_index(creds, "shop"), 2)

    def test_match_rejects_nonsense(self):
        creds = self.creds()
        self.assertIsNone(self.us.match_index(creds, "nope"))
        self.assertIsNone(self.us.match_index(creds, "9"))
        self.assertIsNone(self.us.match_index(creds, ""))

    def test_plain_fill_rotates_through_the_matches(self):
        args = types.SimpleNamespace(pick=False, account=None, forget=False)
        seen = []
        for _ in range(4):
            cred, note = self.us.choose_account(self.creds(), "https://example.com/login", args)
            seen.append(cred["login"])
            self.assertIn("/3", note)
        self.assertEqual(seen[:3], ["me@example.com", "me@corp.example", "shopping@example.com"])
        self.assertEqual(seen[3], "me@example.com", "rotation should wrap")

    def test_explicit_choice_is_reused_not_rotated_past(self):
        # The bug this caught: the next plain fill advanced past the chosen account.
        args = types.SimpleNamespace(pick=False, account="Work", forget=False)
        cred, _ = self.us.choose_account(self.creds(), "https://example.com/login", args)
        self.assertEqual(cred["login"], "me@corp.example")
        plain = types.SimpleNamespace(pick=False, account=None, forget=False)
        cred, _ = self.us.choose_account(self.creds(), "https://example.com/login", plain)
        self.assertEqual(cred["login"], "me@corp.example")
        cred, _ = self.us.choose_account(self.creds(), "https://example.com/login", plain)
        self.assertEqual(cred["login"], "shopping@example.com", "a further press rotates")

    def test_memory_is_per_domain_and_0600(self):
        args = types.SimpleNamespace(pick=False, account="Work", forget=False)
        self.us.choose_account(self.creds(), "https://example.com/login", args)
        self.us.choose_account(self.creds(), "https://other.example/login", args)
        path = pathlib.Path(self.tmp.name) / "omarchy-qutebrowser/keepassxc/accounts.json"
        self.assertTrue(path.is_file())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        saved = json.loads(path.read_text())
        self.assertEqual(sorted(saved), ["example.com", "other.example"])

    def test_forget_clears_only_that_domain(self):
        args = types.SimpleNamespace(pick=False, account="Work", forget=False)
        self.us.choose_account(self.creds(), "https://example.com/login", args)
        forget = types.SimpleNamespace(pick=False, account=None, forget=True)
        cred, note = self.us.choose_account(self.creds(), "https://example.com/login", forget)
        self.assertIsNone(cred)
        self.assertEqual(note, "forgotten")
        path = pathlib.Path(self.tmp.name) / "omarchy-qutebrowser/keepassxc/accounts.json"
        self.assertNotIn("example.com", json.loads(path.read_text()))

    def test_single_match_needs_no_ceremony_and_writes_nothing(self):
        args = types.SimpleNamespace(pick=False, account=None, forget=False)
        cred, note = self.us.choose_account(self.creds()[:1], "https://solo.example/", args)
        self.assertEqual(cred["login"], "me@example.com")
        self.assertEqual(note, "")
        path = pathlib.Path(self.tmp.name) / "omarchy-qutebrowser/keepassxc/accounts.json"
        self.assertFalse(path.exists())

    def test_status_message_tells_the_user_how_to_switch(self):
        args = types.SimpleNamespace(pick=False, account=None, forget=False)
        _, note = self.us.choose_account(self.creds(), "https://example.com/", args)
        self.assertIn("press again", note)
        self.assertIn(",ka", note)


if __name__ == "__main__":
    unittest.main()

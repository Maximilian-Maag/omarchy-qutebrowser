"""Unit tests: qute-keepassxc-fill's pure logic.

The userscript cannot be imported as a module — it has a top-level dependency guard
that calls sys.exit() under an interpreter without PyNaCl — so the declarations we
need are pulled out of its AST and exec'd. That still tests the shipped source.
"""
import ast
import json
import os
import pathlib
import subprocess
import stat
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

    # ── escapes, comments and the FIFO one-line rule ──────────────────────
    def test_one_line_preserves_backslash_escapes_inside_strings(self):
        # A backslash escape inside a quoted string must be copied through, not
        # collapsed away (the `ch == "\\"` branch and its index).
        self.assertEqual(self.us.one_line('"\\na"'), '"\\na"')

    def test_one_line_closes_a_string_before_a_following_comment(self):
        # The closing quote must end the string immediately, so a `//` right after
        # it starts a comment and is stripped — not kept as string contents.
        self.assertEqual(self.us.one_line('"a"//x'), '"a"')

    def test_one_line_copies_a_trailing_backslash_to_end_of_input(self):
        # An unterminated string ending in a backslash: reading one past the end
        # would slip an undefined into the output, so the guard must stop.
        inp = "'abc\\"
        self.assertEqual(self.us.one_line(inp), inp)

    def test_one_line_does_not_insert_a_space_before_a_quote(self):
        # The pending-space flag is only set by whitespace, so `a"b"` keeps no gap.
        self.assertEqual(self.us.one_line('a"b"'), 'a"b"')

    def test_one_line_does_not_leak_pending_space_past_a_quote(self):
        self.assertEqual(self.us.one_line('"a"b'), '"a"b')

    def test_one_line_strips_a_line_comment_at_end_of_input(self):
        self.assertEqual(self.us.one_line("a//b"), "a")

    # ── association key store ─────────────────────────────────────────────
    def test_store_is_idempotent_over_an_existing_directory(self):
        path = os.path.join(self.tmp.name, "deep/nested/keepassxc.key")
        store = self.us.KeyStore(path=path)
        store.store("assoc-1", bytes(range(32)))
        store.store("assoc-2", bytes(32))          # the directory already exists
        self.assertEqual(store.load()[0], "assoc-2")

    # ── account memory ────────────────────────────────────────────────────
    def test_save_pref_defaults_to_rotating(self):
        self.us.save_pref("example.com", {"login": "a", "name": "n", "uuid": "u"})
        prefs = self.us.load_prefs()
        self.assertIs(prefs["example.com"]["rotate"], True,
                      "an unspecified choice must rotate, not be pinned")

    def test_match_by_number_one_is_the_first_entry(self):
        self.assertEqual(self.us.match_index(self.creds(), "1"), 0)

    def test_remembered_index_falls_back_to_a_zero_index(self):
        # An entry stored without a login/name/uuid is found by its index, and
        # index 0 is a valid match (not "no match").
        prefs = {"example.com": {"login": "", "name": "", "uuid": "", "index": 0, "rotate": True}}
        self.assertEqual(self.us.remembered_index(self.creds(), "https://example.com/", prefs), 0)

    # ── the PyNaCl dependency guard ───────────────────────────────────────
    def test_missing_pynacl_exits_with_a_hint(self):
        # Run the shipped script under an interpreter where `nacl` cannot import:
        # the guard must explain itself and exit 1 (not 2, not continue).
        pkg = pathlib.Path(self.tmp.name) / "pkg"
        pkg.mkdir()
        (pkg / "nacl.py").write_text("raise ImportError('blocked for the test')\n")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(pkg)
        env.pop("QUTE_FIFO", None)
        proc = subprocess.run([sys.executable, str(US)], capture_output=True, text=True,
                              env=env, timeout=30)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("PyNaCl", proc.stderr)


if __name__ == "__main__":
    unittest.main()


class PasskeyFrameGuard(UserscriptCase):
    """The fill must stay out of WebAuthn/passkey frames.

    Measured on Microsoft's passkey frame (login.microsoft.com/.../bridge/fido): filling it threw
    `Cannot read properties of undefined (reading 'webelem')` once a second and the passkey sign-in
    never started. A passkey frame has no login form, so the fill must decline outright.
    """

    def test_recognises_a_passkey_frame(self):
        self.assertTrue(self.us.is_passkey_frame(
            "https://login.microsoft.com/9188040d-6c67-4c5b-b112"
            "-36a304b66dad/bridge/fido?fluent=2&cancelUrl=x"))
        self.assertTrue(self.us.is_passkey_frame("https://example.test/webauthn/ceremony"))

    def test_ordinary_login_pages_are_not_passkey_frames(self):
        for url in ("https://accounts.google.com/v3/signin/identifier",
                    "https://login.live.com/login.srf?lc=1033",
                    "https://github.com/login"):
            self.assertFalse(self.us.is_passkey_frame(url), url)

    def test_nothing_is_not_a_passkey_frame(self):
        self.assertFalse(self.us.is_passkey_frame(""))
        self.assertFalse(self.us.is_passkey_frame(None))

    def test_the_match_is_case_insensitive(self):
        self.assertTrue(self.us.is_passkey_frame("HTTPS://LOGIN.MICROSOFT.COM/BRIDGE/FIDO"))


class JsFileRoute(UserscriptCase):
    """Page scripts - and therefore credentials - must never travel as command text.

    Measured: qutebrowser logs every command it runs, so the old inline `jseval` put the username
    and password into the browser log in plaintext:

        Got userscript command: jseval (function () { var USER = "...", PASS = "...", ...

    `qute_js_file` writes the script to a 0600 file and sends `jseval --file <path>`, so only a path
    can appear in a log or a command line. `:jseval --file` was verified working on a live browser.
    """

    def _spy(self):
        """Replace qute() with a spy, and capture the file while it still exists."""
        sent, captured = [], {}
        self.addCleanup(setattr, self.us, "qute", self.us.qute)
        self.addCleanup(setattr, self.us, "JS_FILE_GRACE", self.us.JS_FILE_GRACE)
        self.us.JS_FILE_GRACE = 0

        def spy(cmd):
            sent.append(cmd)
            path = cmd.split("--file ", 1)[1].strip()
            captured["path"] = path
            captured["mode"] = stat.S_IMODE(os.stat(path).st_mode)
            with open(path) as handle:
                captured["body"] = handle.read()

        self.us.qute = spy
        return sent, captured

    def test_the_command_carries_a_path_only(self):
        sent, captured = self._spy()
        self.us.qute_js_file("var PASS = 's3cret-pw';")
        self.assertEqual(1, len(sent))
        self.assertRegex(sent[0], r"^jseval --file \S+$")
        self.assertNotIn("s3cret-pw", sent[0], "the script must never travel as command text")
        self.assertIn("s3cret-pw", captured["body"], "it must arrive through the file")

    def test_the_script_is_0600_while_it_exists(self):
        _, captured = self._spy()
        self.us.qute_js_file("var a = 1;")
        self.assertEqual(0o600, captured["mode"])

    def test_the_script_does_not_linger(self):
        _, captured = self._spy()
        self.us.qute_js_file("var a = 1;")
        self.assertFalse(os.path.exists(captured["path"]), "the credential file must not persist")

    def test_extra_args_are_passed_through(self):
        sent, _ = self._spy()
        self.us.qute_js_file("var t = 1;", extra_args="-q ")
        self.assertRegex(sent[0], r"^jseval -q --file \S+$")

    def test_a_fill_leaks_neither_username_nor_password(self):
        sent, _ = self._spy()
        self.us.qute_js_file(self.us.fill_js("user@example.test", "hunter2", advance=True))
        self.assertNotIn("user@example.test", sent[0])
        self.assertNotIn("hunter2", sent[0])

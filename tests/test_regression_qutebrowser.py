"""Regression tests: specific bugs that were real, and must never come back.

Each test names the bug it pins. These are the ones found by hand and by audit that no
other suite caught — the point is that a reintroduction fails loudly and immediately.
"""
import ast
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent


def load_server():
    path = REPO / "bin/reader-server"
    loader = importlib.machinery.SourceFileLoader("reader_server_reg", str(path))
    spec = importlib.util.spec_from_loader("reader_server_reg", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reader_server_reg"] = mod
    loader.exec_module(mod)
    return mod


def load_userscript(name):
    """Exec a userscript's top-level declarations (they exit at import)."""
    path = REPO / "userscripts" / name
    tree = ast.parse(path.read_text())
    keep = (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign, ast.FunctionDef, ast.ClassDef)
    ns = {"os": os, "sys": sys, "json": json, "pathlib": pathlib, "re": re,
          "subprocess": subprocess, "tempfile": tempfile, "types": types,
          "base64": __import__("base64"), "socket": __import__("socket"),
          "time": __import__("time")}
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, keep)],
                            type_ignores=[]), str(path), "exec"), ns)
    return ns


class RegressionCase(unittest.TestCase):
    def test_publisher_names_are_not_matched_by_bare_substring(self):
        """'Auto Motor und Sport' was labelled RT / state / low factual, because 'rt'
        (rt.com's first label) is a substring of it. Substring matching made the status
        page's lean and balance bar confidently wrong."""
        srv = load_server()
        for name in ("Auto Motor und Sport", "SPEEDWEEK.com", "Fortune"):
            self.assertIsNone(srv.publisher_for("", name), "%s must not match" % name)
        cnn = srv.publisher_for("", "CNN Türk")
        self.assertIsNotNone(cnn, "a whole word must still match")
        self.assertEqual(cnn.get("name"), "CNN")

    def test_zr_is_bound_to_zoom_reset(self):
        """,zr was bound to zoom-load — the same command as ,zl — while zoom-reset was
        defined and bound nowhere, so "forget this domain's zoom" could never reset."""
        cfg = (REPO / "config/config.py").read_text()
        self.assertIn('config.bind(",zr", "zoom-reset"', cfg)
        self.assertIn("'zoom-reset': 'spawn --userscript qute-zoom reset'", cfg)

    def test_bare_t_does_not_shadow_stock_th_and_tl(self):
        """`t` is a strict prefix of stock `th`/`tl` (back/forward in a new tab) and
        qutebrowser runs a binding that has a command before descending into longer ones,
        so binding `t` made both unreachable."""
        cfg = (REPO / "config/config.py").read_text()
        self.assertNotIn('config.bind("t"', cfg)

    def test_ytdl_runner_is_valid_bash_and_reports_a_failure(self):
        """The generated runner was a SYNTAX ERROR (a hand-glued stray quote), so on
        failure the entire reporting block never ran: no log line and no notification —
        a failed download reported nothing at all."""
        src = (REPO / "userscripts/qute-yt-dl").read_text()
        block = re.search(r"^NOTIFY=.*?^chmod \+x \"\$RUNNER\"$", src, re.M | re.S)
        self.assertIsNotNone(block, "the runner generation block moved")
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp)
            (work / "bin").mkdir()
            (work / "state").mkdir()
            (work / "dl").mkdir()
            (work / "bin/notify-send").write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$NOTIFY_LOG"\n')
            (work / "bin/yt-dlp").write_text('#!/bin/bash\nexit "${YTDLP_EXIT:-0}"\n')
            for p in ("bin/notify-send", "bin/yt-dlp"):
                (work / p).chmod(0o755)
            gen = work / "gen.sh"
            gen.write_text(block.group(0))
            env = dict(os.environ)
            env.update({"PATH": "%s:%s" % (work / "bin", env.get("PATH", "")), "HOME": str(work),
                        "STATE_DIR": str(work / "state"), "DOWNLOAD_DIR": str(work / "dl"),
                        "LOG": str(work / "log.txt"), "PIDFILE": str(work / "pid"),
                        "NOTIFY_LOG": str(work / "notify.txt"), "YTDLP": str(work / "bin/yt-dlp"),
                        "OUT_TEMPLATE": str(work / "dl/%(title)s.%(ext)s"),
                        "URL": "https://example.invalid/v"})
            got = subprocess.run(["bash", "-c", 'source "$1" >/dev/null 2>&1; printf "%s" "$RUNNER"',
                                  "_", str(gen)], env=env, capture_output=True, text=True)
            runner = got.stdout.strip()
            self.assertTrue(runner and pathlib.Path(runner).is_file(), got.stderr)
            self.assertEqual(subprocess.run(["bash", "-n", runner], capture_output=True).returncode, 0,
                             "the generated runner must be valid bash")
            env["YTDLP_EXIT"] = "3"
            (work / "notify.txt").write_text("")
            subprocess.run(["bash", runner], env=env, capture_output=True)
            self.assertIn("FAILED (exit 3)", (work / "log.txt").read_text(),
                          "a failed download must be recorded")
            self.assertTrue((work / "notify.txt").read_text().startswith("yt-dlp Download failed"),
                            "and must notify")

    def test_every_paragraph_is_fact_checked(self):
        """fact_check_article had max_paras=12, so everything past the 12th paragraph was
        silently never checked, and one oversized prompt made the model drop entries."""
        srv = load_server()
        srv.news_search = lambda query, lang: []

        def answering(prompt):
            idxs = [int(l.strip().split(".", 1)[0]) for l in prompt.splitlines()
                    if l.strip().split(".", 1)[0].isdigit()]
            return [{"index": i, "verdict": "supported"} for i in idxs]

        srv.run_ai = answering
        paras = ["Paragraph number %d with plenty of words in it to be checked." % i
                 for i in range(20)]
        out = srv.fact_check_article(paras)
        self.assertEqual([o["index"] for o in out], list(range(20)),
                         "all 20 must come back, not the first 12")

    def test_keepassxc_dead_association_is_recoverable(self):
        """A failed test-associate kept the stale key file, so "run again to re-associate"
        took the identical branch and failed identically — a dead end that needed the key
        deleting by hand."""
        sys.path.insert(0, str(REPO / "tests"))
        spec = importlib.util.spec_from_file_location(
            "kpxc_reg", REPO / "tests/test_integration_keepassxc_socket.py")
        kpxc = importlib.util.module_from_spec(spec)
        sys.modules["kpxc_reg"] = kpxc
        spec.loader.exec_module(kpxc)
        us = kpxc.load_userscript()
        peer = kpxc.MockKeepass(lambda payload: {"success": "false"})
        with tempfile.TemporaryDirectory() as tmp:
            key = pathlib.Path(tmp) / "keepassxc.key"
            us.KeyStore(path=str(key)).store("stale", bytes(range(32)))
            self.assertTrue(key.is_file())
            fifo = pathlib.Path(tmp) / "fifo"
            fifo.write_text("")
            os.environ["QUTE_FIFO"] = str(fifo)
            args = types.SimpleNamespace(key_file=str(key), socket=str(peer.path))
            self.assertIsNone(us.connect_keepassxc(args), "must give up, not return a broken client")
            self.assertFalse(key.is_file(), "the stale key must be removed so the next press works")
        peer.dir.cleanup()


if __name__ == "__main__":
    unittest.main()

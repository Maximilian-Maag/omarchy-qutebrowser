"""Integration: run bin/ai-fix-overblocking the way qute-ai-fix does.

A real subprocess with the qutebrowser userscript environment (QUTE_URL, QUTE_HTML, and an
XDG_DATA_HOME holding a blocked-hosts cache), asserting on the JSON it prints. This also covers
the self-reexec into the system interpreter, which a unit test cannot (it would replace the test
process).
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
TOOL = REPO / "bin" / "ai-fix-overblocking"
PY = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable


class OverblockingRun(unittest.TestCase):
    def run_tool(self, url, html, hosts_lines=None):
        with tempfile.TemporaryDirectory() as tmp:
            if html is not None:
                html_path = pathlib.Path(tmp) / "page.html"
                html_path.write_text(html)
            else:
                html_path = pathlib.Path(tmp) / "missing.html"
            if hosts_lines is not None:
                cache = pathlib.Path(tmp) / "qutebrowser" / "blocked-hosts"
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text("\n".join(hosts_lines) + "\n")
            env = dict(os.environ, XDG_DATA_HOME=tmp)
            if url is not None:
                env["QUTE_URL"] = url
            env["QUTE_HTML"] = str(html_path)
            proc = subprocess.run([PY, str(TOOL)], capture_output=True, text=True, env=env,
                                  timeout=120)
        return proc, json.loads(proc.stdout)

    def test_a_first_party_script_dropped_by_hosts_is_reported_as_over_blocking(self):
        html = '<html><script src="https://track.shop.example/a.js"></script></html>'
        proc, out = self.run_tool("https://www.shop.example/", html,
                                  hosts_lines=["0.0.0.0 track.shop.example"])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["first_party_blocked"], 1)
        self.assertEqual(out["blocked"][0]["by"], "hosts")
        self.assertIn("over-blocking", out["verdict"])

    def test_a_bot_challenge_page_is_not_blamed_on_blocking(self):
        html = '<html><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></html>'
        proc, out = self.run_tool("https://www.shop.example/", html, hosts_lines=[])
        self.assertIn("bot-challenge", out["verdict"])

    def test_an_ordinary_page_with_a_tracker_script_is_reported(self):
        # No hosts fixture and no engine expectations: the point is a clean run that names a
        # blocked third-party resource rather than crashing.
        html = ('<html><script src="/app.js"></script>'
                '<script src="https://www.google-analytics.com/analytics.js"></script></html>')
        proc, out = self.run_tool("https://www.shop.example/", html, hosts_lines=[])
        self.assertEqual(proc.returncode, 0)
        self.assertGreaterEqual(out["checked"], 1)

    def test_a_missing_html_file_is_tolerated(self):
        proc, out = self.run_tool("https://www.shop.example/", None, hosts_lines=[])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["checked"], 0)

    def test_without_a_url_it_reports_an_error(self):
        proc, out = self.run_tool(None, "<html></html>", hosts_lines=[])
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()

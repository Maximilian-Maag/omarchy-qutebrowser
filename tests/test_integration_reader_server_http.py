"""HTTP-level tests for bin/reader-server.

A real loopback server is started on an ephemeral port with the module's state
directories pointed at a temp tree, and requests go through urllib — so routing,
the token check, the escaping of embedded JSON and the size/error guards are all
exercised as behaviour, not called as functions.
"""
import importlib.machinery
import importlib.util
import http.client
import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
ARTICLE_ID = "0123456789abcdef"
TOKEN = "test-token"


def load_server(name="reader_server_http"):
    path = REPO / "bin/reader-server"
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    loader.exec_module(mod)
    return mod


class HttpCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = load_server()
        cls.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(cls.tmp.name)
        cls.saved = {k: getattr(cls.srv, k) for k in
                     ("STATE_DIR", "ARTICLES_DIR", "STATE_STORE", "SERVER_JSON")}
        cls.srv.STATE_DIR = root / "state"
        cls.srv.ARTICLES_DIR = root / "state" / "articles"
        cls.srv.STATE_STORE = root / "state" / "article-state"
        cls.srv.SERVER_JSON = root / "state" / "server.json"
        cls.srv.ARTICLES_DIR.mkdir(parents=True, exist_ok=True)
        cls.srv.STATE_STORE.mkdir(parents=True, exist_ok=True)
        (cls.srv.ARTICLES_DIR / ("%s.json" % ARTICLE_ID)).write_text(
            json.dumps({"title": 'He said "hi"', "url": 'https://ex.com/p?q="z"'}))
        (cls.srv.ARTICLES_DIR / ("%s.html" % ARTICLE_ID)).write_text("<p>body</p>")
        cls.srv.Handler.token = TOKEN
        cls.httpd = cls.srv.ThreadingHTTPServer(("127.0.0.1", 0), cls.srv.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls.saved.items():
            setattr(cls.srv, k, v)
        cls.tmp.cleanup()

    def setUp(self):
        self.saved_ai = self.srv.run_ai
        self.addCleanup(lambda: setattr(self.srv, "run_ai", self.saved_ai))

    def url(self, path, token=TOKEN):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def get(self, path, token=TOKEN):
        sep = "&" if "?" in path else "?"
        req = urllib.request.Request(self.url("%s%st=%s" % (path, sep, token)))
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def post(self, path, body, token=TOKEN, raw=False):
        sep = "&" if "?" in path else "?"
        data = body if raw else json.dumps(body).encode()
        req = urllib.request.Request(self.url("%s%st=%s" % (path, sep, token)),
                                     data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # -- auth / routing ---------------------------------------------------- #
    def test_health_needs_no_token_and_reports_build(self):
        status, body = self.get("/health", token="")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["build"], self.srv.BUILD)

    def test_status_requires_the_token(self):
        status, _ = self.get("/status/%s" % ARTICLE_ID, token="wrong")
        self.assertEqual(status, 403)

    def test_unknown_route_is_404(self):
        status, _ = self.get("/nope")
        self.assertEqual(status, 404)

    # -- escaping of embedded values (status page) ------------------------- #
    def test_status_page_escapes_title_and_url(self):
        status, body = self.get("/status/%s" % ARTICLE_ID)
        self.assertEqual(status, 200)
        self.assertIn(b"&quot;", body,
                      "quotes in the title/url must be HTML-escaped")
        self.assertIn(b'He said &quot;hi&quot;', body)
        self.assertIn(b"https://ex.com/p?q=&quot;z&quot;", body,
                      "the article URL must be escaped too")

    # -- /ai guards -------------------------------------------------------- #
    def test_ai_oversize_payload_is_rejected(self):
        limit = 4 * 1024 * 1024
        # Build a payload whose serialised length is exactly the limit.
        overhead = len(json.dumps({"mode": "paragraph", "text": ""}))
        text = "a" * (limit - overhead)
        data = json.dumps({"mode": "paragraph", "text": text}).encode()
        self.assertEqual(len(data), limit)
        self.srv.run_ai = lambda prompt: {}
        status, body = self.post("/ai", data, raw=True)
        self.assertNotEqual(status, 413, "exactly 4 MiB is under the limit")
        self.assertEqual(status, 200)

    def test_ai_payload_over_the_limit_is_413(self):
        limit = 4 * 1024 * 1024
        # Announce an oversized body and read the server's verdict without pumping
        # 4 MiB at a connection the server has already decided to reject.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.putrequest("POST", "/ai?t=%s" % TOKEN)
            conn.putheader("Content-Length", str(limit + 1))
            conn.putheader("Content-Type", "application/json")
            conn.endheaders()
            resp = conn.getresponse()
            status, body = resp.status, resp.read()
        finally:
            conn.close()
        self.assertEqual(status, 413)
        self.assertIs(json.loads(body)["ok"], False)

    def test_ai_malformed_json_is_400(self):
        status, body = self.post("/ai", b"{not json", raw=True)
        self.assertEqual(status, 400)
        self.assertIs(json.loads(body)["ok"], False)

    def test_ai_paragraph_round_trip(self):
        self.srv.run_ai = lambda prompt: {"ai_likelihood": 3}
        status, body = self.post("/ai", {"mode": "paragraph", "text": "Hello"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True, "result": {"ai_likelihood": 3}})

    # -- /framing guards --------------------------------------------------- #
    def test_framing_requires_text(self):
        status, body = self.post("/framing", {"title": "only a title"})
        self.assertEqual(status, 400)
        self.assertIs(json.loads(body)["ok"], False)

    def test_framing_timeout_is_504(self):
        def boom(prompt):
            raise subprocess.TimeoutExpired("hermes", 1)
        self.srv.run_ai = boom
        status, body = self.post("/framing", {"text": "some article text"})
        self.assertEqual(status, 504)
        self.assertIs(json.loads(body)["ok"], False)


if __name__ == "__main__":
    unittest.main()

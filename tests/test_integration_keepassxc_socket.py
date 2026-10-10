"""Integration tests: the KeepassXC browser-socket client, against a mock peer.

The socket client was the biggest uncovered block in the plugin: mutation testing left
23 of 24 mutants alive, nearly all of them in this protocol code. This stands up a
peer that speaks the real protocol — plaintext `change-public-keys` handshake, then
encrypted messages inside a `nacl.public.Box` — so the client's handshake, request
shape, success parsing and error mapping are all exercised for real, with no KeePassXC
and no unlocked database.

The userscript cannot be imported as a module (its dependency guard calls sys.exit),
so its declarations are pulled out of the AST and exec'd — the shipped code either way.
"""
import ast
import base64
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
US = REPO / "userscripts/qute-keepassxc-fill"

try:
    import nacl.public
    import nacl.utils
except ImportError:                                    # pragma: no cover - env dependent
    nacl = None


def load_userscript():
    """Exec the userscript's declarations in a namespace we control.

    Its imports sit inside a module-level try/except (the dependency guard that calls
    sys.exit), and top-level try blocks are deliberately skipped — so the namespace is
    pre-seeded with the modules the code uses. Without this the classes execute against
    a NameError for every module they touch.
    """
    mod = types.SimpleNamespace()
    tree = ast.parse(US.read_text())
    keep = (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign,
            ast.FunctionDef, ast.ClassDef)
    body = [n for n in tree.body if isinstance(n, keep)]
    ns = mod.__dict__
    ns.update({"os": os, "sys": sys, "json": json, "base64": base64, "socket": socket,
               "tempfile": tempfile, "time": __import__("time"), "re": __import__("re"),
               "subprocess": __import__("subprocess"), "nacl": nacl})
    exec(compile(ast.Module(body=body, type_ignores=[]), str(US), "exec"), ns)
    return mod


def read_message(conn, timeout=5):
    """A stream socket has no message boundaries — read until the JSON parses."""
    conn.settimeout(timeout)
    chunks = []
    while True:
        try:
            chunk = conn.recv(65536)
        except (socket.timeout, BlockingIOError, InterruptedError):
            return None
        if not chunk:
            return None
        chunks.append(chunk)
        try:
            return json.loads(b"".join(chunks).decode())
        except ValueError:
            continue


class MockKeepass:
    """Enough of KeePassXC-Browser to make the client do its job."""

    def __init__(self, responder=None, handshake=None):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup = self.dir.cleanup
        self.path = os.path.join(self.dir.name, "kp.sock")
        self.responder = responder or (lambda payload: {"success": "true"})
        self.handshake = handshake or {}
        self.requests = []
        self.handshake_seen = None
        self.error = None
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        try:
            conn, _ = self.listener.accept()
        except OSError:
            return
        server_key = nacl.public.PrivateKey.generate()
        hello = read_message(conn)                     # plaintext handshake
        if hello is None:
            return
        self.handshake_seen = hello
        client_key = nacl.public.PublicKey(base64.b64decode(hello["publicKey"]))
        box = nacl.public.Box(server_key, client_key)
        reply = {
            "action": "change-public-keys",
            "publicKey": base64.b64encode(server_key.public_key.encode()).decode(),
            "nonce": base64.b64encode(nacl.utils.random(24)).decode(),
            "success": "true",
            "clientID": hello.get("clientID"),
        }
        reply.update(self.handshake)                   # let a test break the handshake on purpose
        conn.sendall(json.dumps(reply).encode())
        while True:
            msg = read_message(conn)
            if msg is None:
                return
            payload = json.loads(box.decrypt(base64.b64decode(msg["message"]),
                                             base64.b64decode(msg["nonce"])).decode())
            self.requests.append(payload)
            reply = self.responder(payload)
            if reply is None:
                reply = {"success": "true"}
            if isinstance(reply, dict) and "error" in reply and reply.get("outer"):
                conn.sendall(json.dumps(reply, default=str).encode())
                continue
            nonce = nacl.utils.random(nacl.public.Box.NONCE_SIZE)
            cipher = box.encrypt(json.dumps(reply).encode(), nonce).ciphertext
            conn.sendall(json.dumps({
                "action": payload.get("action"),
                "message": base64.b64encode(cipher).decode(),
                "nonce": base64.b64encode(nonce).decode(),
                "clientID": msg.get("clientID"),
            }).encode())


@unittest.skipUnless(nacl, "PyNaCl missing (the userscript requires it)")
class SocketClientCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.us = load_userscript()

    def client(self, responder=None, **kw):
        mock = MockKeepass(responder, **kw)
        self.addCleanup(mock.dir.cleanup)
        seed = bytes(range(32))
        kp = self.us.KeePassXC(key_seed=seed, socket_path=mock.path)
        return kp, mock

    # ── handshake ─────────────────────────────────────────────────────────
    def test_connect_performs_the_public_key_handshake(self):
        kp, mock = self.client()
        kp.connect()
        self.assertEqual(mock.handshake_seen["action"], "change-public-keys")
        self.assertIn("publicKey", mock.handshake_seen)
        self.assertIn("clientID", mock.handshake_seen)
        self.assertIsNotNone(kp.box, "connect() must build the encryption box")

    def test_the_client_socket_gets_a_read_timeout(self):
        # Without a timeout a KeePassXC that accepts but never answers hangs the
        # keypress forever, so the socket must carry the plugin's timeout.
        kp, mock = self.client()
        kp.connect()
        self.assertEqual(self.us.SOCKET_TIMEOUT, 8)
        self.assertEqual(kp.sock.gettimeout(), 8)

    def test_a_rejected_handshake_raises_and_names_the_failure(self):
        kp, mock = self.client(handshake={"success": "false"})
        with self.assertRaises(self.us.KpError) as ctx:
            kp.connect()
        self.assertEqual(ctx.exception.code, -1)
        self.assertIn("handshake failed", str(ctx.exception))
        self.assertIsNone(kp.box, "a failed handshake must not build the box")

    def test_connect_without_a_socket_raises_a_clear_error(self):
        kp = self.us.KeePassXC(key_seed=bytes(32),
                               socket_path="/tmp/definitely-not-here-%d.sock" % os.getpid())
        with self.assertRaises(self.us.KpError) as ctx:
            kp.connect()
        self.assertEqual(ctx.exception.code, -1)
        self.assertIn("socket", str(ctx.exception).lower())

    # ── requests go out with the right shape ──────────────────────────────
    def test_test_associate_sends_id_and_idkey(self):
        kp, mock = self.client(lambda p: {"success": "true"})
        kp.connect()
        self.assertTrue(kp.test_associate("assoc-1"))
        sent = mock.requests[-1]
        self.assertEqual(sent["action"], "test-associate")
        self.assertEqual(sent["id"], "assoc-1")
        self.assertEqual(sent["key"], base64.b64encode(kp.id_key.public_key.encode()).decode())

    def test_test_associate_is_false_without_an_association(self):
        kp, mock = self.client()
        kp.connect()
        self.assertFalse(kp.test_associate(""))
        self.assertEqual(mock.requests, [], "no request should be sent for an empty id")

    def test_test_associate_reports_a_refused_association(self):
        kp, mock = self.client(lambda p: {"success": "false"})
        kp.connect()
        self.assertFalse(kp.test_associate("assoc-1"))

    def test_associate_returns_the_new_id(self):
        kp, mock = self.client(lambda p: {"success": "true", "id": "fresh-id"})
        kp.connect()
        self.assertEqual(kp.associate(), "fresh-id")
        self.assertEqual(mock.requests[-1]["action"], "associate")
        self.assertIn("idKey", mock.requests[-1])

    def test_get_logins_returns_entries_and_survives_an_empty_answer(self):
        entries = [{"name": "Personal", "login": "me@example.com", "uuid": "aaaa1111"}]
        kp, mock = self.client(lambda p: {"success": "true", "entries": entries})
        kp.connect()
        kp.assoc_id = "assoc-1"
        self.assertEqual(kp.get_logins("https://example.com"), entries)
        sent = mock.requests[-1]
        self.assertEqual(sent["action"], "get-logins")
        self.assertEqual(sent["url"], "https://example.com")
        self.assertEqual(sent["keys"][0]["id"], "assoc-1")

        kp2, _ = self.client(lambda p: {"success": "true"})
        kp2.connect()
        kp2.assoc_id = "assoc-1"
        self.assertEqual(kp2.get_logins("https://example.com"), [],
                         "a reply with no entries must be an empty list, not a crash")

    def test_get_totp_returns_the_code_or_nothing(self):
        kp, _ = self.client(lambda p: {"success": "true", "totp": "123456"})
        kp.connect()
        self.assertEqual(kp.get_totp("uuid-1"), "123456")

        for reply in ({"success": "false", "totp": "123456"}, {"success": "true"},
                      {"success": "true", "totp": ""}):
            kp, _ = self.client(lambda p, r=reply: r)
            kp.connect()
            self.assertIsNone(kp.get_totp("uuid-1"), reply)

    # ── error mapping ─────────────────────────────────────────────────────
    def test_an_error_reply_becomes_a_KpError_with_code_and_text(self):
        kp, _ = self.client(lambda p: {"error": "Database not opened", "errorCode": 1, "outer": True})
        kp.connect()
        kp.assoc_id = "assoc-1"
        with self.assertRaises(self.us.KpError) as ctx:
            kp.get_logins("https://example.com")
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("Database not opened", str(ctx.exception))

    def test_a_missing_error_code_still_raises(self):
        kp, _ = self.client(lambda p: {"error": "unknown", "outer": True})
        kp.connect()
        kp.assoc_id = "assoc-1"
        with self.assertRaises(self.us.KpError) as ctx:
            kp.get_logins("https://example.com")
        self.assertEqual(ctx.exception.code, -1)


@unittest.skipUnless(nacl, "PyNaCl missing")
class KeyStoreCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.us = load_userscript()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env = {k: os.environ.get(k) for k in ("QUTE_DATA_DIR", "XDG_DATA_HOME")}
        for key in ("QUTE_DATA_DIR", "XDG_DATA_HOME"):
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_qute_data_dir_wins_over_xdg(self):
        os.environ["QUTE_DATA_DIR"] = self.tmp.name
        os.environ["XDG_DATA_HOME"] = "/somewhere/else"
        store = self.us.KeyStore()
        self.assertEqual(store.path, os.path.join(self.tmp.name, "keepassxc.key"))

    def test_xdg_data_home_is_the_fallback(self):
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        store = self.us.KeyStore()
        self.assertEqual(store.path, os.path.join(self.tmp.name, "qutebrowser", "keepassxc.key"))

    def test_store_then_load_round_trips_the_key_0600(self):
        store = self.us.KeyStore(path=os.path.join(self.tmp.name, "deep/keepassxc.key"))
        seed = bytes(range(32))
        self.assertFalse(store.exists())
        store.store("assoc-9", seed)
        self.assertTrue(store.exists())
        self.assertEqual(os.stat(store.path).st_mode & 0o777, 0o600,
                         "the association key must not be world readable")
        assoc_id, loaded = store.load()
        self.assertEqual(assoc_id, "assoc-9")
        self.assertEqual(loaded, seed)


if __name__ == "__main__":
    unittest.main()

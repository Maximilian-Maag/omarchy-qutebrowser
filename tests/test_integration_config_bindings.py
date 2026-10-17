"""Integration: the plugin's keybindings must not squat on qutebrowser's own.

config.py is executed with a recording stub for `config.bind`, and every binding it makes
is compared against qutebrowser's DEFAULT bindings. A plugin binding that reuses a stock
key silently DISABLES the stock command (the later binding wins) — which is how `gd`
stopped being qutebrowser's `download` and became a zoom alias. Skipped when the
qutebrowser package (and its configdata.yml) is not installed.
"""
import pathlib
import re
import sys
import types
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
CFG = REPO / "config"


class _Auto:
    def __getattr__(self, name):
        child = _Auto()
        setattr(self, name, child)
        return child

    def __call__(self, *a, **k):
        return None


class _RecordingConfig:
    """Stands in for qutebrowser's `config`, recording every bind()."""
    configdir = pathlib.Path.home() / ".config" / "qutebrowser"

    def __init__(self):
        self.binds = []

    def bind(self, sequence, command, mode="normal", *args, **kwargs):
        self.binds.append((mode, sequence, command))

    def set(self, *a, **k):
        return None

    def source(self, *a, **k):
        return None

    def load_autoconfig(self, *a, **k):
        return None


def load_config():
    """Exec config.py with stubs; return the recording `config`."""
    c = _Auto()
    config = _RecordingConfig()
    if str(CFG) not in sys.path:
        sys.path.insert(0, str(CFG))
    stub = types.ModuleType("omarchy_webauthn")
    setattr(stub, "install", lambda *a, **k: None)
    saved = sys.modules.get("omarchy_webauthn")
    sys.modules["omarchy_webauthn"] = stub
    try:
        exec(compile((CFG / "config.py").read_text(), str(CFG / "config.py"), "exec"),
             {"c": c, "config": config, "__file__": str(CFG / "config.py"),
              "__name__": "config"})
    finally:
        if saved is None:
            sys.modules.pop("omarchy_webauthn", None)
        else:
            sys.modules["omarchy_webauthn"] = saved
    return config


def _configdata_path():
    """Path to qutebrowser's configdata.yml, found without importing qutebrowser.

    The suite runs under the mise interpreter, where qutebrowser (a system package for
    /usr/bin/python3) is not importable — importing it would silently skip this guard.
    """
    try:
        import qutebrowser
        mod_file = getattr(qutebrowser, "__file__", None)
        if mod_file:
            path = pathlib.Path(mod_file).parent / "config" / "configdata.yml"
            if path.is_file():
                return path
    except Exception:
        pass
    import glob
    for pattern in ("/usr/lib/python3*/site-packages/qutebrowser/config/configdata.yml",
                    "/usr/lib/python3/dist-packages/qutebrowser/config/configdata.yml",
                    "/usr/local/lib/python3*/site-packages/qutebrowser/config/configdata.yml"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return pathlib.Path(hits[-1])
    return None


def qutebrowser_normal_defaults():
    """{key: command} for qutebrowser's default NORMAL mode, or None if unavailable."""
    yml = _configdata_path()
    if yml is None:
        return None
    text = yml.read_text()
    after = re.search(r"^bindings\.default:\s*$", text, re.M)
    if not after:
        return None
    lines = text[after.end():].splitlines()
    out, normal_indent = {}, None
    for line in lines:
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if normal_indent is None:
            # the tree is `bindings.default: -> default: -> normal:`; take the first
            # `normal:` at any depth and then its children, whatever the indentation.
            if stripped == "normal:":
                normal_indent = indent
            continue
        if indent <= normal_indent:
            break                           # next mode
        match = re.match(r"\s*([^:#]+):\s*(\S.*)$", line)
        if match:
            key = match.group(1).strip()
            out.setdefault(key, match.group(2).split("#")[0].strip())
    return out or None


class BindingCollisionCase(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.defaults = qutebrowser_normal_defaults()

    def test_config_registers_bindings(self):
        self.assertTrue(self.config.binds, "config.py registered no bindings at all")

    def test_no_plugin_binding_overrides_a_qutebrowser_default(self):
        if self.defaults is None:
            self.skipTest("qutebrowser's configdata.yml is not installed here")
        clashes = []
        for mode, sequence, command in self.config.binds:
            if mode != "normal" or sequence not in self.defaults:
                continue
            stock = self.defaults[sequence]
            if stock != command:
                clashes.append((sequence, command, stock))
        self.assertEqual(clashes, [], "plugin bindings that disable a stock qutebrowser "
                                      "binding (key, plugin, qutebrowser): %r" % (clashes,))

    def test_a_known_collision_would_be_caught(self):
        """The guard must be able to fail: feed it the gd case that really happened."""
        if self.defaults is None:
            self.skipTest("qutebrowser's configdata.yml is not installed here")
        fake = [(("normal", "gd", "zoom-load"))]
        clashes = [(seq, cmd, self.defaults[seq]) for mode, seq, cmd in fake
                   if mode == "normal" and seq in self.defaults
                   and self.defaults[seq] != cmd]
        self.assertEqual([c[0] for c in clashes], ["gd"])


if __name__ == "__main__":
    unittest.main()

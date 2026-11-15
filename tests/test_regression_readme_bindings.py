"""Regression: documented key bindings must match what config.py actually binds.

Two source-of-truth drifts are locked out here:
  * the README's Key bindings table listed `t` = "Open new tab", but config.py binds
    `t` nowhere (the `t` binding was deliberately removed because it shadowed stock
    `th`/`tl`), so the table advertised a dead key;
  * the feature prose wrote `,pw` for the password fill, but config.py binds only `pw`
    (`,p` is the private window), so `,pw` described a binding that does not exist.

And, defensively: the USCRIPTS document bindings in their own docstrings, and those
drift the same way. qute-zoom's docstring advertised a `gd` alias for ,zl that
config.py deliberately never bound (qutebrowser owns `gd` = download), so the script
told users to press a key that does something else entirely.

config.py is data; this asserts on the shipped text of the files.
"""
import pathlib
import re
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
README = REPO / "README.md"
CONFIG = REPO / "config" / "config.py"
USERSCRIPTS = REPO / "userscripts"

# A table row whose Key column is exactly `t`, i.e. `| `t` | ... |`.
_T_ROW = re.compile(r"^\|\s*`t`\s*\|", re.M)

# A `Keybinding: ,r   (Reader)` line, as used by qute-reader / qute-ai-fix.
_KEYBINDING = re.compile(r"Keybinding:\s*(\S+)")
# A `Bindings (config.py):` block, whose rows are `<key>   description`.
_BINDINGS_HEADING = re.compile(r"^\s*Bindings \(config\.py\):\s*$", re.M)
_BINDING_ROW = re.compile(r"^\s*(,?[A-Za-z0-9][\w+<>,\-]*)\s{2,}\S", re.M)


def readme_t_row_present(text):
    return bool(_T_ROW.search(text))


def documented_bindings(path):
    """Key sequences a userscript's docstring claims are bound in config.py."""
    text = pathlib.Path(path).read_text()
    keys = [m.group(1) for m in _KEYBINDING.finditer(text)]
    heading = _BINDINGS_HEADING.search(text)
    if heading:
        # skip the rest of the heading line itself (heading.end() is before the \n)
        for line in text[heading.end():].splitlines()[1:]:
            if not line.strip():
                break                       # the block ends at a blank line
            row = _BINDING_ROW.match(line)
            if row:
                keys.append(row.group(1))
    return keys


def _config_binds(config_text, key):
    return ('config.bind("%s"' % key) in config_text


class ReadmeBindingsCase(unittest.TestCase):
    def setUp(self):
        self.readme = README.read_text()
        self.config = CONFIG.read_text()

    def test_the_readme_does_not_advertise_the_unbound_t_key(self):
        self.assertFalse(readme_t_row_present(self.readme),
                         "README lists `t` as a binding but config.py binds `t` nowhere")
        # It really is unbound: no `config.bind("t" ...)` anywhere.
        self.assertNotIn('config.bind("t"', self.config)

    def test_the_readme_does_not_advertise_the_nonexistent_comma_pw_binding(self):
        self.assertNotIn("`,pw`", self.readme,
                         "README documents `,pw` but config.py binds only `pw`")
        self.assertIn('config.bind("pw"', self.config)

    def test_the_guard_can_still_fail(self):
        # The exact old rows must trip the checker.
        self.assertTrue(readme_t_row_present("| `t` | normal | Open new tab |\n"))


class UserscriptBindingsCase(unittest.TestCase):
    """Every binding a userscript documents must exist in config.py."""

    def setUp(self):
        self.config = CONFIG.read_text()

    def _python_userscripts(self):
        for path in sorted(USERSCRIPTS.iterdir()):
            if path.is_file() and path.suffix != ".js":
                yield path

    def test_every_documented_binding_is_bound_in_config(self):
        missing = []
        for path in self._python_userscripts():
            for key in documented_bindings(path):
                if not _config_binds(self.config, key):
                    missing.append((path.name, key))
        self.assertEqual(missing, [],
                         "userscripts document bindings config.py does not bind "
                         "(script, key): %r" % (missing,))

    def test_qute_zoom_drops_the_removed_gd_alias(self):
        self.assertNotIn("gd", documented_bindings(USERSCRIPTS / "qute-zoom"),
                         "qute-zoom still documents the `gd` alias config.py never bound")
        # The four real bindings are still documented.
        self.assertEqual(documented_bindings(USERSCRIPTS / "qute-zoom"),
                         [",z+", ",z-", ",zl", ",zr"])

    def test_the_scanner_reads_both_conventions(self):
        # A stale row of either shape must be surfaced as a documented binding.
        with tempfile.TemporaryDirectory() as tmp:
            doc = pathlib.Path(tmp) / "script"
            doc.write_text(
                '"""x\nBindings (config.py):\n  ,q1   do a thing\n  ,q2   do another\n\n'
                'Usage: nope\n"""\n\nKeybinding: ,q3   (Thing)\n')
            self.assertEqual(documented_bindings(doc), [",q3", ",q1", ",q2"])


if __name__ == "__main__":
    unittest.main()

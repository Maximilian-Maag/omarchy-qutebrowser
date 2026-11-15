"""Regression: the README's key-binding docs must match what config.py actually binds.

Two source-of-truth drifts are locked out here:
  * the Key bindings table listed `t` = "Open new tab", but config.py binds `t` nowhere
    (the `t` binding was deliberately removed because it shadowed stock `th`/`tl`), so the
    table advertised a dead key;
  * the feature prose wrote `,pw` for the password fill, but config.py binds only `pw`
    (`,p` is the private window), so `,pw` described a binding that does not exist.

config.py is data; this asserts on the shipped text of both files.
"""
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
README = REPO / "README.md"
CONFIG = REPO / "config" / "config.py"

# A table row whose Key column is exactly `t`, i.e. `| `t` | ... |`.
_T_ROW = re.compile(r"^\|\s*`t`\s*\|", re.M)


def readme_t_row_present(text):
    return bool(_T_ROW.search(text))


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


if __name__ == "__main__":
    unittest.main()

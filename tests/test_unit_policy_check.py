"""Unit tests: tools/policy_check.py, the policy engine this repository runs on.

The checker is what keeps the repository honest, so its own rules are pinned here:
a declared test kind with no tests, a mutation config with no targets or a weak
threshold, a source file neither mutated nor exempted, and a CI file that does not
run the suite must all FAIL. The rules are exercised against synthetic repositories
in a temp directory, so the real tree is never touched.

Every assertion names the RULE, not just the exit code, so a rule that fires for the
wrong reason is caught too. Both directions are covered: a rule must FAIL when it
should, and a clean repository must report no failures.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
import unittest.mock as mock

REPO = pathlib.Path(__file__).resolve().parent.parent


def load_checker():
    spec = importlib.util.spec_from_file_location("policy_check", REPO / "tools/policy_check.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["policy_check"] = mod
    spec.loader.exec_module(mod)
    return mod


class PolicyCheckCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pc = load_checker()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.write("tools/mutator.py", "x = 1\n")
        self.write("tools/run_tests.sh", "#!/bin/bash\necho hi\n")

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def spec(self, **over):
        base = {
            "kinds": ["unit"],
            "files": {},
            "runner": "tools/run_tests.sh",
            "mutator": "tools/mutator.py",
            "mutation_config": "tests/mutation.json",
            "ci": ".github/workflows/test.yml",
            "min_kill_rate": 0.80,
            "source_globs": ["bin/*"],
        }
        base.update(over)
        return base

    def mutation(self, rate=0.85, targets=None, exempt=None):
        data = {"min_kill_rate": rate,
                "targets": targets if targets is not None else
                [{"path": "bin/thing", "lang": "shell", "tests": ["true"]}]}
        if exempt is not None:
            data["exempt"] = exempt
        self.write("tests/mutation.json", json.dumps(data))
        self.write("bin/thing", "#!/bin/bash\necho x\n")
        self.write(".github/workflows/test.yml", "run: bash tools/run_tests.sh\n")
        self.write("tests/test_unit_a.py", "# t\n")

    def check(self, spec):
        rep = self.pc.Report()
        self.pc.check_tests(self.root, [], {"tests": spec}, rep)
        return rep

    @staticmethod
    def failures(rep):
        return {rule for status, rule, _ in rep.results if status == "FAIL"}

    @staticmethod
    def warnings(rep):
        return {rule for status, rule, _ in rep.results if status == "WARN"}

    # ── the small helpers ────────────────────────────────────────────────
    def test_report_tracks_failures(self):
        rep = self.pc.Report()
        rep.ok("a")
        rep.warn("b", "")
        self.assertFalse(rep.failed)
        rep.fail("c", "because")
        self.assertTrue(rep.failed)

    def test_sample_truncates_with_a_count(self):
        self.assertEqual(self.pc.sample(["a", "b", "c", "d"], 2), "a, b (+2 more)")

    def test_allowed_matches_exact_paths_and_globs(self):
        bucket = {"a.txt": "x", "docs/*.md": "y"}
        self.assertTrue(self.pc.allowed(bucket, "a.txt"))
        self.assertTrue(self.pc.allowed(bucket, "docs/readme.md"))
        self.assertFalse(self.pc.allowed(bucket, "docs/readme.rst"))

    def test_checker_version_and_file_size_limits_are_pinned(self):
        # The version is what policy.json must agree with; the size limit decides
        # which files are skipped. Both are literals the mutator nudges.
        self.assertEqual(self.pc.CHECKER_VERSION, 3)
        self.assertEqual(self.pc.MAX_FILE_BYTES, 512 * 1024)

    def test_run_returns_stdout_only_for_success(self):
        self.assertEqual(self.pc.run("bash", "-c", "printf hello"), "hello")
        self.assertEqual(self.pc.run("bash", "-c", "exit 3"), "")

    def test_run_passes_a_timeout(self):
        captured = {}

        def fake(cmd, **kw):
            captured.update(kw)
            return types.SimpleNamespace(returncode=0, stdout="ok")

        with mock.patch.object(self.pc.subprocess, "run", fake):
            self.pc.run("true")
        self.assertEqual(captured.get("timeout"), 120)

    def test_is_text_rejects_binary_content(self):
        self.assertTrue(self.pc.is_text(b"hello\n"))
        self.assertFalse(self.pc.is_text(b"a\x00b"))

    # ── the test-kind and mutation rules ─────────────────────────────────
    def test_a_declared_kind_without_a_file_fails(self):
        self.mutation()
        rep = self.check(self.spec(kinds=["unit", "regression"]))
        self.assertIn("tests/regression-present", self.failures(rep))

    def test_a_complete_layout_passes(self):
        self.mutation()
        rep = self.check(self.spec())
        self.assertFalse(rep.failed, [r for r in rep.results if r[0] == "FAIL"])

    def test_missing_tests_section_warns(self):
        rep = self.pc.Report()
        self.pc.check_tests(self.root, [], {}, rep)
        self.assertIn("tests/layout", self.warnings(rep))

    def test_a_missing_harness_file_fails(self):
        self.mutation()
        rep = self.check(self.spec(runner="tools/absent.sh"))
        self.assertIn("tests/harness-missing", self.failures(rep))

    def test_no_mutation_targets_fails(self):
        self.mutation(targets=[])
        rep = self.check(self.spec())
        self.assertIn("tests/mutation-targets", self.failures(rep))

    def test_a_target_that_does_not_exist_fails(self):
        self.mutation(targets=[{"path": "bin/absent", "lang": "shell", "tests": ["true"]}])
        rep = self.check(self.spec())
        self.assertIn("tests/mutation-targets", self.failures(rep))

    def test_an_unparsable_mutation_config_fails(self):
        self.mutation()
        self.write("tests/mutation.json", "{not json")
        rep = self.check(self.spec())
        self.assertIn("tests/mutation-config", self.failures(rep))

    def test_a_threshold_below_the_floor_fails(self):
        self.mutation(rate=0.50)
        rep = self.check(self.spec(min_kill_rate=0.80))
        self.assertIn("tests/mutation-threshold", self.failures(rep))

    def test_a_threshold_equal_to_the_floor_passes(self):
        # Exactly at the bar is inside it: 0.80 < 0.80 is false. A `<=` mutant fails here.
        self.mutation(rate=0.80)
        rep = self.check(self.spec(min_kill_rate=0.80))
        self.assertNotIn("tests/mutation-threshold", self.failures(rep))

    def test_a_missing_kill_rate_fails(self):
        self.mutation(rate=None)
        rep = self.check(self.spec())
        self.assertIn("tests/mutation-threshold", self.failures(rep))

    def test_an_unaccounted_source_file_fails(self):
        self.mutation()
        self.write("bin/orphan", "#!/bin/bash\n")
        rep = self.check(self.spec())
        self.assertIn("tests/no-gaps", self.failures(rep))

    def test_an_exempt_entry_without_a_reason_fails(self):
        self.mutation(exempt=[{"path": "bin/thing"}])
        rep = self.check(self.spec())
        self.assertIn("tests/no-gaps", self.failures(rep))

    def test_an_exempt_entry_with_a_reason_passes(self):
        self.mutation(exempt=[{"path": "bin/orphan", "reason": "wrapper only"}])
        self.write("bin/orphan", "#!/bin/bash\n")
        rep = self.check(self.spec())
        self.assertNotIn("tests/no-gaps", self.failures(rep))

    def test_integration_kind_is_dropped_when_not_applicable(self):
        # integration_applicable=false must remove only the integration kind: the
        # unit module still exists and nothing should fail.
        self.mutation()
        rep = self.check(self.spec(kinds=["unit", "integration"], integration_applicable=False))
        self.assertNotIn("tests/integration-present", self.failures(rep))
        self.assertFalse(rep.failed, [r for r in rep.results if r[0] == "FAIL"])

    def test_ci_must_run_the_test_suite(self):
        self.mutation()
        self.write(".github/workflows/test.yml", "run: echo nope\n")
        rep = self.check(self.spec())
        self.assertIn("tests/ci-runs-suite", self.failures(rep))

    def test_ci_file_missing_fails(self):
        self.mutation()
        os.remove(self.root / ".github/workflows/test.yml")
        rep = self.check(self.spec())
        self.assertIn("tests/ci-missing", self.failures(rep))

    # ── the manifest rules ───────────────────────────────────────────────
    def full_manifest(self, **over):
        m = {"id": "a.b", "name": "n", "version": "1.2.0",
             "author": "x", "license": "MIT", "description": "d"}
        m.update(over)
        return json.dumps(m)

    def manifest_check(self):
        rep = self.pc.Report()
        self.pc.check_manifest(self.root, [], {"plugin": True}, rep)
        return rep

    def test_a_clean_manifest_passes(self):
        self.write("manifest.json", self.full_manifest())
        self.write("CHANGELOG.md", "## [1.2.0] — 2026-01-01\n")
        rep = self.manifest_check()
        self.assertFalse(rep.failed, [r for r in rep.results if r[0] == "FAIL"])

    def test_manifest_missing_fails(self):
        rep = self.manifest_check()
        self.assertIn("plugin/manifest-exists", self.failures(rep))

    def test_manifest_that_does_not_parse_fails(self):
        self.write("manifest.json", "{not json")
        rep = self.manifest_check()
        self.assertIn("plugin/manifest-parses", self.failures(rep))

    def test_manifest_version_must_match_the_changelog(self):
        self.write("manifest.json", self.full_manifest(version="1.2.0"))
        self.write("CHANGELOG.md", "## [1.1.0] — 2026-01-01\n")
        rep = self.manifest_check()
        self.assertIn("plugin/version-matches-changelog", self.failures(rep))

    def test_manifest_missing_required_keys_fails(self):
        self.write("manifest.json", json.dumps({"id": "a.b"}))
        self.write("CHANGELOG.md", "## [1.0.0] — 2026-01-01\n")
        rep = self.manifest_check()
        self.assertIn("plugin/manifest-keys", self.failures(rep))

    def test_reserved_and_malformed_ids_fail(self):
        self.write("CHANGELOG.md", "## [1.2.0] — 2026-01-01\n")
        self.write("manifest.json", self.full_manifest(id="omarchy.mine"))
        self.assertIn("plugin/id-namespace", self.failures(self.manifest_check()))
        self.write("manifest.json", self.full_manifest(id="nodot"))
        self.assertIn("plugin/id-namespace", self.failures(self.manifest_check()))

    def test_a_missing_changelog_fails(self):
        self.write("manifest.json", self.full_manifest())
        rep = self.manifest_check()
        self.assertIn("plugin/changelog", self.failures(rep))

    def test_a_changelog_without_a_version_heading_fails(self):
        self.write("manifest.json", self.full_manifest())
        self.write("CHANGELOG.md", "notes only, no heading\n")
        rep = self.manifest_check()
        self.assertIn("plugin/changelog", self.failures(rep))

    def test_an_install_script_must_parse(self):
        self.write("manifest.json", self.full_manifest())
        self.write("CHANGELOG.md", "## [1.2.0] — 2026-01-01\n")
        self.write("install.sh", "#!/bin/bash\nif [ 1\n")
        rep = self.manifest_check()
        self.assertIn("plugin/install-parses", self.failures(rep))

    def test_install_script_is_checked_with_captured_output(self):
        self.write("manifest.json", self.full_manifest())
        self.write("CHANGELOG.md", "## [1.2.0] — 2026-01-01\n")
        self.write("install.sh", "#!/bin/bash\ntrue\n")
        captured = {}

        def fake(cmd, **kw):
            captured.update(kw)
            return types.SimpleNamespace(returncode=0)

        with mock.patch.object(self.pc.subprocess, "run", fake):
            rep = self.manifest_check()
        self.assertNotIn("plugin/install-parses", self.failures(rep))
        self.assertTrue(captured.get("capture_output"))

    # ── the syntax rules ─────────────────────────────────────────────────
    def syntax_check(self, files):
        rep = self.pc.Report()
        self.pc.check_syntax(self.root, files, {}, rep)
        return rep

    def test_bad_json_fails_syntax(self):
        self.write("bad.json", "{oops")
        self.assertIn("syntax/json-parses", self.failures(self.syntax_check(["bad.json"])))

    def test_bad_python_fails_syntax(self):
        self.write("bad.py", "def f(:\n")
        self.assertIn("syntax/python-compiles", self.failures(self.syntax_check(["bad.py"])))

    def test_bad_shell_fails_syntax(self):
        self.write("bad.sh", "#!/bin/bash\nif [ x\n")
        self.assertIn("syntax/shell-parses", self.failures(self.syntax_check(["bad.sh"])))

    @unittest.skipUnless(subprocess.run(["which", "node"], capture_output=True).returncode == 0,
                         "node not installed")
    def test_bad_javascript_fails_syntax(self):
        self.write("bad.js", "function ({\n")
        self.assertIn("syntax/js-parses", self.failures(self.syntax_check(["bad.js"])))

    def test_clean_files_have_no_syntax_failures(self):
        self.write("good.py", "x = 1\n")
        self.write("good.json", '{"a": 1}\n')
        rep = self.syntax_check(["good.py", "good.json"])
        self.assertFalse(self.failures(rep), sorted(self.failures(rep)))

    # ── the shell rules ──────────────────────────────────────────────────
    def test_a_non_bash_shebang_warns(self):
        self.write("script.sh", "#!/usr/bin/env bash\necho hi\n")
        rep = self.pc.Report()
        self.pc.check_shebangs(self.root, ["script.sh"], {"shebang": "bash"}, rep)
        self.assertIn("shell/shebang-bash", self.warnings(rep))

    def test_a_bash_shebang_does_not_warn(self):
        self.write("script.sh", "#!/bin/bash\necho hi\n")
        rep = self.pc.Report()
        self.pc.check_shebangs(self.root, ["script.sh"], {"shebang": "bash"}, rep)
        self.assertNotIn("shell/shebang-bash", self.warnings(rep))

    def test_shell_style_flags_quoted_vars_outside_bin(self):
        # A .sh script that is not under /bin/ must still be scanned.
        self.write("hooks/x.sh", '[[ "$a" == "b" ]]\n[[ $n -gt 3 ]]\n')
        rep = self.pc.Report()
        self.pc.check_shell_style(self.root, ["hooks/x.sh"], {"shell_style": True}, rep)
        warns = self.warnings(rep)
        self.assertIn("shell/no-quoted-var-in-[[ ]]", warns)
        self.assertIn("shell/use-(( ))-for-numbers", warns)

    # ── the hygiene rules ────────────────────────────────────────────────
    def hygiene(self, files, ls_lines):
        rep = self.pc.Report()
        with mock.patch.object(self.pc, "run", return_value="\n".join(ls_lines)):
            self.pc.check_hygiene(self.root, files, {"allow": {}}, rep)
        return rep

    def test_conflict_markers_fail_hygiene(self):
        self.write("f.txt", "<<<<<<< HEAD\nx\n")
        rep = self.hygiene(["f.txt"], ["100644 a 0\tf.txt"])
        self.assertIn("hygiene/no-conflict-markers", self.failures(rep))

    def test_secrets_fail_hygiene(self):
        # Built at runtime so this test's own source does not trip the secret scan.
        self.write("f.txt", "-----BEGIN " + "RSA PRIVATE KEY-----\nzzz\n")
        rep = self.hygiene(["f.txt"], ["100644 a 0\tf.txt"])
        self.assertIn("hygiene/no-secrets", self.failures(rep))

    def test_absolute_home_paths_fail_hygiene(self):
        self.write("f.txt", "path = /home/" + "alice/thing\n")
        rep = self.hygiene(["f.txt"], ["100644 a 0\tf.txt"])
        self.assertIn("hygiene/no-absolute-home-paths", self.failures(rep))

    def test_a_missing_final_newline_warns(self):
        self.write("f.txt", "no newline at the end")
        rep = self.hygiene(["f.txt"], ["100644 a 0\tf.txt"])
        self.assertIn("hygiene/ends-with-newline", self.warnings(rep))

    def test_build_artifacts_fail_hygiene(self):
        rep = self.hygiene(["dist/bundle.js"], ["100644 a 0\tdist/bundle.js"])
        self.assertIn("hygiene/no-build-artifacts", self.failures(rep))

    def test_a_symlink_fails_hygiene(self):
        rep = self.hygiene(["link"], ["120000 a 0\tlink"])
        self.assertIn("hygiene/no-symlinks", self.failures(rep))

    def test_a_clean_tree_has_no_hygiene_failures(self):
        self.write("bin/thing", "#!/bin/bash\necho hi\n")
        self.write("README.md", "readme\n")
        rep = self.hygiene(["bin/thing", "README.md"],
                           ["100644 a 0\tbin/thing", "100644 b 0\tREADME.md"])
        self.assertFalse(self.failures(rep), sorted(self.failures(rep)))

    # ── the npm rules ────────────────────────────────────────────────────
    def npm_check(self):
        rep = self.pc.Report()
        self.pc.check_npm(self.root, [], {}, rep)
        return rep

    def test_a_broken_package_json_fails(self):
        self.write("package.json", "{not json")
        self.assertIn("node/package-parses", self.failures(self.npm_check()))

    def test_missing_npm_scripts_warn(self):
        self.write("package.json", json.dumps({"name": "x"}))
        self.assertIn("node/scripts-declared", self.warnings(self.npm_check()))

    def test_a_complete_package_json_passes(self):
        self.write("package.json", json.dumps({"scripts": {"test": "true", "lint": "true"}}))
        rep = self.npm_check()
        self.assertNotIn("node/package-parses", self.failures(rep))
        self.assertNotIn("node/scripts-declared", self.warnings(rep))

    # ── version-bump and omarchy-validate rules ──────────────────────────
    def test_code_without_a_version_bump_warns(self):
        rep = self.pc.Report()
        with mock.patch.object(self.pc, "git", return_value=["userscripts/x"]):
            self.pc.check_version_bumped(self.root, [], {"plugin": True}, rep, True)
        self.assertIn("plugin/version-bumped-with-code", self.warnings(rep))

    def test_bumping_the_manifest_silences_the_warning(self):
        rep = self.pc.Report()
        with mock.patch.object(self.pc, "git", return_value=["userscripts/x", "manifest.json"]):
            self.pc.check_version_bumped(self.root, [], {"plugin": True}, rep, True)
        self.assertNotIn("plugin/version-bumped-with-code", self.warnings(rep))

    def test_omarchy_validate_reports_the_failure_output(self):
        captured = {}

        def fake_run(cmd, **kw):
            captured.update(kw)
            return types.SimpleNamespace(returncode=1, stdout="ERR", stderr="MSG")

        rep = self.pc.Report()
        with mock.patch.object(self.pc, "run", return_value="/usr/bin/omarchy"), \
                mock.patch.object(self.pc.subprocess, "run", fake_run):
            self.pc.check_omarchy_validate(self.root, [], {"plugin": True}, rep, True)
        fails = {rule: detail for status, rule, detail in rep.results if status == "FAIL"}
        self.assertIn("plugin/omarchy-validate", fails)
        self.assertIn("ERRMSG", fails["plugin/omarchy-validate"])

    # ── the JS batch helper ──────────────────────────────────────────────
    def test_check_js_returns_nothing_without_node(self):
        with mock.patch.object(self.pc.shutil, "which", return_value=None), \
                mock.patch.object(self.pc.subprocess, "run",
                                  side_effect=AssertionError("node must not be invoked")):
            self.assertEqual(self.pc._check_js(["x.js"]), [])

    def test_check_js_reports_files_node_cannot_parse(self):
        with mock.patch.object(self.pc.shutil, "which", return_value="/usr/bin/node"), \
                mock.patch.object(self.pc.subprocess, "run",
                                  return_value=types.SimpleNamespace(stdout='["x.js"]', returncode=0)):
            self.assertEqual(self.pc._check_js(["x.js"]), ["x.js"])

    # ── the driver (config scope / output) ───────────────────────────────
    def git_repo(self, files, added=True):
        for rel, text in files.items():
            self.write(rel, text)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        if added:
            subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)

    def run_policy(self, args=()):
        return subprocess.run(
            [sys.executable, str(REPO / "tools/policy_check.py"), *args],
            cwd=self.root, capture_output=True, text=True)

    def test_config_checker_version_matches_is_not_a_failure(self):
        self.write("policy.json", json.dumps({"checker": self.pc.CHECKER_VERSION}))
        self.git_repo({"a.txt": "x\n", "b.txt": "y\n"})
        data = json.loads(self.run_policy(["--json"]).stdout)
        fails = {r["rule"] for r in data["results"] if r["status"] == "FAIL"}
        self.assertNotIn("config/checker-version", fails)

    def test_config_checker_version_mismatch_is_a_failure(self):
        self.write("policy.json", json.dumps({"checker": self.pc.CHECKER_VERSION - 1}))
        self.git_repo({"a.txt": "x\n", "b.txt": "y\n"})
        data = json.loads(self.run_policy(["--json"]).stdout)
        fails = {r["rule"] for r in data["results"] if r["status"] == "FAIL"}
        self.assertIn("config/checker-version", fails)

    def empty_git_repo(self):
        # Only itself in the tree: the params in setUp() are untracked extras.
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)

    def test_scope_reports_no_files_found_on_an_empty_repo(self):
        # --ci with nothing changed and nothing tracked: no base ref is usable and
        # no file is found, so the driver must fail rather than pass on nothing.
        self.write("policy.json", json.dumps({"checker": self.pc.CHECKER_VERSION}))
        self.empty_git_repo()
        data = json.loads(self.run_policy(["--json", "--ci"]).stdout)
        fails = {r["rule"] for r in data["results"] if r["status"] == "FAIL"}
        self.assertIn("scope/files-found", fails)

    def test_scope_accepts_exactly_two_files(self):
        os.remove(self.root / "tools/mutator.py")
        os.remove(self.root / "tools/run_tests.sh")
        self.write("policy.json", json.dumps({"checker": self.pc.CHECKER_VERSION}))
        self.git_repo({"a.txt": "x\n"})
        data = json.loads(self.run_policy(["--json"]).stdout)
        fails = {r["rule"] for r in data["results"] if r["status"] == "FAIL"}
        self.assertNotIn("scope/files-found", fails)

    def test_human_output_ends_with_the_summary_line(self):
        self.write("policy.json", json.dumps({"checker": self.pc.CHECKER_VERSION}))
        self.git_repo({}, added=False)
        proc = self.run_policy([])
        self.assertIn("policy_check v", proc.stdout)


if __name__ == "__main__":
    unittest.main()

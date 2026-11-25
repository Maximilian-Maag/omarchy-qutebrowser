#!/usr/bin/env python3
"""Unit tests for tools/build_cosmetic.py — the filter-list parser.

The parser is the part that decides what gets hidden on every site the user visits, so the
tests pin the decisions rather than the output size: which rule kinds are kept, which are
dropped (network, procedural, generic, negated domains), and that an exception can only ever
remove a selector.
"""

import importlib.util
import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("build_cosmetic",
                                               REPO / "tools" / "build_cosmetic.py")
build_cosmetic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_cosmetic)


class ParseRuleCase(unittest.TestCase):
    def test_domain_scoped_hide_rule_is_kept(self):
        self.assertEqual(build_cosmetic.parse_cosmetic_rule("golem.de##.go-ad-slot"),
                         (0, "golem.de", ".go-ad-slot"))

    def test_exception_is_parsed_as_kind_one(self):
        self.assertEqual(
            build_cosmetic.parse_cosmetic_rule("golem.de#@##taboola-below-article-thumbnails"),
            (1, "golem.de", "#taboola-below-article-thumbnails"))

    def test_comma_separated_domains_are_lowercased(self):
        kind, domains, selector = build_cosmetic.parse_cosmetic_rule("A.example,B.example##.ad")
        self.assertEqual((kind, domains, selector), (0, "a.example,b.example", ".ad"))

    def test_procedural_filter_is_dropped(self):
        # uBlock syntax, not CSS: a stylesheet cannot express it, and shipping it would
        # poison the rule it sits in.
        for selector in ("div:has-text(Anzeige)", ".x:style(color:red)", ".-abp-element"):
            with self.subTest(selector=selector):
                self.assertIsNone(
                    build_cosmetic.parse_cosmetic_rule("example.org##" + selector))

    def test_css_has_pseudo_class_is_kept(self):
        # `:has(` is real CSS (Chromium 105+), and golem.de's own rules use it.
        self.assertEqual(
            build_cosmetic.parse_cosmetic_rule("golem.de##.go-ticker-teaser:has(.go-label--sponsored)"),
            (0, "golem.de", ".go-ticker-teaser:has(.go-label--sponsored)"))

    def test_generic_rule_is_dropped(self):
        self.assertIsNone(build_cosmetic.parse_cosmetic_rule("##.ad-banner"))

    def test_network_rules_are_dropped(self):
        for line in ("||ads.example^", "@@||ads.example^$script", "/banner[0-9]+/"):
            with self.subTest(line=line):
                self.assertIsNone(build_cosmetic.parse_cosmetic_rule(line))

    def test_negated_and_wildcard_domains_are_dropped(self):
        # These need uBlock's matcher; a domain -> selector map would silently apply them
        # to the wrong sites.
        self.assertIsNone(build_cosmetic.parse_cosmetic_rule("~example.org##.ad"))
        self.assertIsNone(build_cosmetic.parse_cosmetic_rule("*.example.org##.ad"))

    def test_extended_syntax_is_dropped(self):
        self.assertIsNone(build_cosmetic.parse_cosmetic_rule("example.org#?#div:-abp-has(.ad)"))

    def test_a_selector_containing_the_separator_is_kept_whole(self):
        # A `##` inside the selector must not be treated as a second separator: splitting
        # with maxsplit=1 keeps `.a##.b` intact, splitting further would truncate it.
        self.assertEqual(build_cosmetic.parse_cosmetic_rule("example.org##.a##.b"),
                         (0, "example.org", ".a##.b"))

    def test_comments_and_headers_are_dropped(self):
        for line in ("! comment", "[Adblock Plus 2.0]", "", "   "):
            with self.subTest(line=line):
                self.assertIsNone(build_cosmetic.parse_cosmetic_rule(line))


class NoiseCase(unittest.TestCase):
    def test_blank_is_noise(self):
        self.assertTrue(build_cosmetic.is_noise(""))

    def test_comment_is_noise(self):
        self.assertTrue(build_cosmetic.is_noise("! EasyList"))
        self.assertTrue(build_cosmetic.is_noise("[Adblock Plus 2.0]"))

    def test_a_rule_is_not_noise(self):
        self.assertFalse(build_cosmetic.is_noise("golem.de##.go-ad-slot"))


class CollectCase(unittest.TestCase):
    def test_selectors_are_grouped_and_sorted(self):
        table = build_cosmetic.collect([
            "golem.de##.go-ad-slot",
            "golem.de##.go-alink-list",
            "golem.de##.go-ad-slot",
            "heise.de##.ads",
        ])
        self.assertEqual(table["golem.de"], [".go-ad-slot", ".go-alink-list"])
        self.assertEqual(table["heise.de"], [".ads"])

    def test_exception_removes_only_that_selector(self):
        table = build_cosmetic.collect([
            "golem.de##.keep-me",
            "golem.de##.drop-me",
            "golem.de#@#.drop-me",
        ])
        self.assertEqual(table["golem.de"], [".keep-me"])

    def test_exception_cannot_add_a_selector(self):
        table = build_cosmetic.collect(["golem.de#@#.never-hidden"])
        self.assertEqual(table, {})

    def test_a_domain_left_empty_by_exceptions_disappears(self):
        # So the userscript never injects an empty style element for that domain.
        table = build_cosmetic.collect(["example.org##.only", "example.org#@#.only"])
        self.assertNotIn("example.org", table)


class LoadSourceCase(unittest.TestCase):
    def test_an_existing_cache_directory_is_reused(self):
        # A second run on the same cache directory must not fail on mkdir; the profile keeps
        # this directory between rebuilds.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "list.txt"
            source.write_text("example.org##.ad\n")
            cache = pathlib.Path(tmp) / "a" / "b" / "cache"   # nested: parents=True matters
            first = build_cosmetic.load_source(str(source), cache)
            second = build_cosmetic.load_source(str(source), cache)
        self.assertEqual(first, second)
        self.assertEqual(len(second), 1)


class RenderCase(unittest.TestCase):
    def test_data_marker_is_replaced_once_with_the_blob(self):
        template = '// header\nvar COSMETIC_BLOB = "";  // @data\ntail\n'
        out = build_cosmetic.render(template, {"domains": {"golem.de": [".go-ad-slot"]}})
        self.assertIn('var COSMETIC_BLOB = "\\ngolem.de\\t.go-ad-slot\\n";  // @data', out)
        self.assertNotIn('COSMETIC_BLOB = ""', out)
        self.assertIn("// header", out)
        self.assertIn("tail", out)

    def test_a_selector_with_a_backslash_is_escaped_for_javascript(self):
        # CSS escapes exist (`.a\\:b`); the literal has to still be one JS string.
        out = build_cosmetic.render('var COSMETIC_BLOB = "";  // @data\n',
                                    {"domains": {"example.org": [".a\\:b"]}})
        self.assertIn(r".a\\:b", out)

    def test_encode_blob_is_records_of_tab_separated_fields(self):
        blob = build_cosmetic.encode_blob({"b.org": [".y"], "a.org": [".x", ".z"]})
        self.assertEqual(blob, "\na.org\t.x\t.z\nb.org\t.y\n")

    def test_encode_blob_drops_a_rule_that_would_break_the_format(self):
        # A newline or tab inside a selector cannot be represented; the rule is skipped
        # rather than corrupting the record around it.
        blob = build_cosmetic.encode_blob({"a.org": [".ok", ".bad\nx", ".bad\ty"]})
        self.assertEqual(blob, "\na.org\t.ok\n")

    def test_encode_blob_skips_a_domain_with_no_usable_selectors(self):
        self.assertEqual(build_cosmetic.encode_blob({"a.org": [], "b.org": ["\n"]}), "")

    def test_non_ascii_selectors_are_written_as_utf8_not_escaped(self):
        # Escaped output would still parse, but it triples the size of a table whose
        # selectors are mostly German words; the script is served as UTF-8.
        out = build_cosmetic.render("var COSMETIC_DATA = {};  // @data\n",
                                    {"domains": {"example.org": [".werbung-für"]}})
        self.assertIn(".werbung-für", out)
        self.assertNotIn("\\u00fc", out)

    def test_the_domain_table_is_sorted(self):
        out = build_cosmetic.render("var COSMETIC_DATA = {};  // @data\n",
                                    {"domains": {"z.example": [".b", ".a"],
                                                 "a.example": [".c"]}})
        self.assertLess(out.index("a.example\\t"), out.index("z.example\\t"))
        self.assertIn("z.example\\t.b\\t.a", out)   # selectors keep their given order

    def test_template_without_the_marker_is_an_error(self):
        with self.assertRaises(ValueError):
            build_cosmetic.render("// no marker here\n", {"domains": {}})


class BuildCase(unittest.TestCase):
    def test_build_reads_a_plain_filesystem_path(self):
        # config/cosmetic-extra.txt is handed to build() as a path, not a URL.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "extra.txt"
            source.write_text("golem.de##.go-teaser--item-variant-affiliate\n")
            data = build_cosmetic.build([str(source)], pathlib.Path(tmp))
        self.assertEqual(data["domains"]["golem.de"], [".go-teaser--item-variant-affiliate"])

    def test_build_applies_an_exception_from_a_later_source(self):
        # A `#@#` line in the extra file must be able to cancel a list's rule. build() used
        # to skip kind != 0 entirely, so the exception was parsed and then dropped: the
        # selector stayed hidden and the list's "don't hide this" did nothing.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            listing = tmp / "list.txt"
            listing.write_text("example.org##.teaser\nexample.org##.keep\n")
            extra = tmp / "extra.txt"
            extra.write_text("example.org#@#.teaser\n")
            data = build_cosmetic.build([str(listing), str(extra)], tmp)
        self.assertEqual(data["domains"]["example.org"], [".keep"])

    def test_build_keeps_a_rule_the_exception_does_not_name(self):
        # The exception is per selector, not per domain: one cancellation must not clear
        # the rest of the domain's list.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            listing = tmp / "list.txt"
            listing.write_text("example.org##.a\nexample.org##.b\nother.org##.a\n")
            extra = tmp / "extra.txt"
            extra.write_text("example.org#@#.a\n")
            data = build_cosmetic.build([str(listing), str(extra)], tmp)
        self.assertEqual(data["domains"]["example.org"], [".b"])
        self.assertEqual(data["domains"]["other.org"], [".a"])

    def test_main_compiles_the_extra_rules_after_the_lists(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            template = tmp / "t.js"
            template.write_text("var COSMETIC_DATA = {};  // @data\n")
            extra = tmp / "extra.txt"
            extra.write_text("golem.de##.only-in-extra\n")
            output = tmp / "out.js"
            rc = build_cosmetic.main(["--template", str(template), "--output", str(output),
                                      "--extra", str(extra), "--source", str(extra)])
            self.assertEqual(rc, 0)
            self.assertIn(".only-in-extra", output.read_text())

    def test_main_writes_nothing_on_a_dry_run(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            template = tmp / "t.js"
            template.write_text("var COSMETIC_DATA = {};  // @data\n")
            extra = tmp / "extra.txt"
            extra.write_text("golem.de##.go-ad-slot\n")
            output = tmp / "out.js"
            rc = build_cosmetic.main(["--template", str(template), "--output", str(output),
                                      "--extra", str(extra), "--source", str(extra),
                                      "--dry-run"])
            self.assertEqual(rc, 0)
            self.assertFalse(output.exists())

    def test_main_requires_an_output_path(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            extra = tmp / "extra.txt"
            extra.write_text("golem.de##.x\n")
            template = tmp / "t.js"
            template.write_text("var COSMETIC_DATA = {};  // @data\n")
            with self.assertRaises(SystemExit):
                build_cosmetic.main(["--template", str(template), "--extra", str(extra)])

    def test_main_refuses_a_named_extra_file_that_does_not_exist(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            template = tmp / "t.js"
            template.write_text("var COSMETIC_DATA = {};  // @data\n")
            rc = build_cosmetic.main(["--template", str(template), "--output",
                                      str(tmp / "out.js"), "--extra", str(tmp / "absent.txt")])
        self.assertEqual(rc, 2)

    def test_build_reads_a_local_list_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "list.txt"
            source.write_text("! header\ngolem.de##.go-ad-slot\nexample.org##.ad\n")
            data = build_cosmetic.build(["file://" + str(source)], pathlib.Path(tmp))
        self.assertEqual(data["domains"]["golem.de"], [".go-ad-slot"])
        self.assertEqual(data["domains"]["example.org"], [".ad"])


if __name__ == "__main__":
    unittest.main()

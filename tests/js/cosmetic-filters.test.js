// Unit tests for userscripts/cosmetic-filters.js — the pure parts.
//
// The script is an IIFE; the helpers are sliced out of the shipped source and evaluated in a
// sandbox, the same way adblock.test.js tests youtube-adblock.js. What matters here is the
// per-host lookup: a selector must reach the site the list names and no other, because a
// cosmetic rule applied to the wrong host is a broken page.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'userscripts', 'cosmetic-filters.js'), 'utf8');

function helpers() {
  const names = ['cosmeticHosts', 'cosmeticSelectors', 'cosmeticCss', 'cosmeticParent'];
  const parts = names.map((name) => {
    const start = SOURCE.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, `not found in source: function ${name}(`);
    return SOURCE.slice(start, SOURCE.indexOf('\n}\n', start) + 2);
  });
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n'), ctx);
  return ctx;
}

// The generated format: one record per line, `<domain>\t<selector>\t<selector>…`, with a
// leading and trailing newline. Written out by hand rather than through the builder, so the
// test fails if the format or the lookup changes.
const BLOB = '\ngolem.de\t.go-ad-slot\t.go-alink-list\nwww.example.org\t.only-www\n';

// Arrays built inside the vm have that realm's Array prototype, which deepStrictEqual
// rejects; the selectors are compared as a string.
const sel = (host, blob = BLOB) => helpers().cosmeticSelectors(host, blob).join('|');

test('an exact host gets its selectors', () => {
  assert.strictEqual(sel('golem.de'), '.go-ad-slot|.go-alink-list');
});

test('a subdomain falls back to the list entry for its parent', () => {
  assert.strictEqual(sel('www.golem.de'), '.go-ad-slot|.go-alink-list');
  assert.strictEqual(sel('a.b.golem.de'), '.go-ad-slot|.go-alink-list');
});

test('an entry for the subdomain itself is honoured and not widened', () => {
  assert.strictEqual(sel('www.example.org'), '.only-www');
  assert.strictEqual(sel('example.org'), '');
});

test('an unrelated host gets nothing, even when it shares a label', () => {
  assert.strictEqual(sel('notgolem.de'), '');
  assert.strictEqual(sel('golem.de.example.com'), '');
});

test('a host with no dots (localhost) never matches a list entry', () => {
  assert.strictEqual(sel('localhost'), '');
  assert.strictEqual(sel(''), '');
});

test('selectors from a parent and the host itself are combined without duplicates', () => {
  const blob = '\ngolem.de\t.a\t.b\nwww.golem.de\t.b\t.c\n';
  // most specific first, then the parent's — order is irrelevant to CSS, but the
  // deduplication must not drop the parent's `.a` or repeat `.b`.
  assert.strictEqual(sel('www.golem.de', blob), '.b|.c|.a');
});

test('cosmeticHosts lists the host and every parent domain but the TLD', () => {
  const { cosmeticHosts } = helpers();
  assert.strictEqual(cosmeticHosts('a.b.golem.de').join('|'), 'a.b.golem.de|b.golem.de|golem.de');
});

test('the style element goes into <head> when there is one', () => {
  const { cosmeticParent } = helpers();
  const head = { tag: 'head' };
  const root = { tag: 'html' };
  assert.strictEqual(cosmeticParent({ head, documentElement: root }), head);
});

test('the style element falls back to <html> before <head> exists', () => {
  const { cosmeticParent } = helpers();
  const root = { tag: 'html' };
  assert.strictEqual(cosmeticParent({ head: null, documentElement: root }), root);
  assert.strictEqual(cosmeticParent({}), null);
});

test('the CSS is one rule per selector so an invalid one cannot drop the rest', () => {
  const { cosmeticCss } = helpers();
  assert.strictEqual(cosmeticCss(['.a', '.b']),
    '.a{display:none !important;}\n.b{display:none !important;}');
  assert.strictEqual(cosmeticCss([]), '');
});

test('the shipped template has the data marker the builder replaces', () => {
  assert.ok(/^\s*var COSMETIC_BLOB = .*; {2}\/\/ @data$/m.test(SOURCE),
    'cosmetic-filters.js must carry the `// @data` marker');
});

test('a domain that is a prefix of another cannot borrow its rules', () => {
  // `de` appears inside `golem.de`; the record search anchors on the surrounding newline
  // and tab so only a whole domain matches.
  const blob = '\ngolem.de\t.go-ad-slot\nexample.de\t.only-example\n';
  assert.strictEqual(sel('golem.de', blob), '.go-ad-slot');
  assert.strictEqual(sel('de', blob), '');
  assert.strictEqual(sel('mple.de', blob), '');
});

test('a malformed blob degrades to no rules instead of throwing', () => {
  assert.strictEqual(sel('golem.de', ''), '');
  assert.strictEqual(sel('golem.de', null), '');
  assert.strictEqual(sel('golem.de', '\ngolem.de'), '');
});

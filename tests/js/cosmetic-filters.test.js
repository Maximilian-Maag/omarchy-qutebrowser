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

const DATA = {
  domains: {
    'golem.de': ['.go-ad-slot', '.go-alink-list'],
    'www.example.org': ['.only-www'],
  },
};

// Arrays built inside the vm have that realm's Array prototype, which deepStrictEqual
// rejects; the selectors are compared as a string.
const sel = (host, data) => helpers().cosmeticSelectors(host, data).join('|');

test('an exact host gets its selectors', () => {
  assert.strictEqual(sel('golem.de', DATA), '.go-ad-slot|.go-alink-list');
});

test('a subdomain falls back to the list entry for its parent', () => {
  assert.strictEqual(sel('www.golem.de', DATA), '.go-ad-slot|.go-alink-list');
  assert.strictEqual(sel('a.b.golem.de', DATA), '.go-ad-slot|.go-alink-list');
});

test('an entry for the subdomain itself is honoured and not widened', () => {
  assert.strictEqual(sel('www.example.org', DATA), '.only-www');
  assert.strictEqual(sel('example.org', DATA), '');
});

test('an unrelated host gets nothing, even when it shares a label', () => {
  assert.strictEqual(sel('notgolem.de', DATA), '');
  assert.strictEqual(sel('golem.de.example.com', DATA), '');
});

test('a host with no dots (localhost) never matches a list entry', () => {
  assert.strictEqual(sel('localhost', DATA), '');
  assert.strictEqual(sel('', DATA), '');
});

test('selectors from a parent and the host itself are combined without duplicates', () => {
  const data = { domains: { 'golem.de': ['.a', '.b'], 'www.golem.de': ['.b', '.c'] } };
  // most specific first, then the parent's — order is irrelevant to CSS, but the
  // deduplication must not drop the parent's `.a` or repeat `.b`.
  assert.strictEqual(sel('www.golem.de', data), '.b|.c|.a');
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
  assert.ok(/^\s*var COSMETIC_DATA = .*; {2}\/\/ @data$/m.test(SOURCE),
    'cosmetic-filters.js must carry the `// @data` marker');
});

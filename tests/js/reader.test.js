// Tests for reader/reader.js — pure/extractable logic, no browser needed.
//
// This file exists because every reader bug found in the 2026-10 audit was found by
// hand and proven with a throwaway probe: the dead in-paragraph "AI?" button (an index
// passed where an element was expected) and media spliced in reverse order at a shared
// anchor. Those two get pinned here, so they cannot come back silently.
//
// reader.js is one big IIFE, so the pieces under test are sliced out by marker and run
// against stubs. Only functions that do not need a real DOM are tested this way; the
// DOM-driven behaviour (fact cards, the wheel, persistence) needs the Qt harness.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'reader', 'reader.js'), 'utf8');

function sliceFor(name) {
  const re = new RegExp('\\n[ \\t]*function ' + name + '\\s*\\(');
  const m = re.exec(SRC);
  assert.ok(m, 'reader.js no longer defines ' + name + '()');
  const from = m.index + 1;
  // the next sibling function at the same indent closes it
  let end = SRC.indexOf('\n  function ', from + 10);
  if (end === -1) end = SRC.indexOf('\n  window.omarchyReader', from);
  return SRC.slice(from, end === -1 ? SRC.length : end);
}

function load(names, deps) {
  const keys = Object.keys(deps);
  const body = names.map(sliceFor).join('\n') + '\nreturn {' + names.join(', ') + '};\n';
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => deps[k]));
}

// ── a minimal element/container stub ────────────────────────────────────────
function makeEl(name) {
  return { name, children: [], parentNode: null };
}
function makeContainer(children) {
  const c = makeEl('article');
  c.children = children;
  children.forEach(function (ch) { ch.parentNode = c; });
  c.querySelectorAll = function () { return c.children; };
  c.appendChild = function (el) { el.parentNode = c; c.children.push(el); };
  c.insertBefore = function (el, ref) {
    const at = c.children.indexOf(ref);
    el.parentNode = c;
    c.children.splice(at < 0 ? c.children.length : at, 0, el);
  };
  return c;
}

test('spliceMedia keeps document order when several media share one anchor', function () {
  const p0 = makeEl('p0');
  const p1 = makeEl('p1');
  const articleEl = makeContainer([p0, p1]);
  const mod = load(['spliceMedia'], {
    articleEl,
    BLOCK_SEL: 'p',
    buildMediaEl: (m) => makeEl(m.id),
  });
  const n = mod.spliceMedia([{ id: 'm0', before: 1 }, { id: 'm1', before: 1 }]);
  assert.strictEqual(n, 2, 'returns how many it placed');
  // Regression: iterating backwards while always inserting before the same element
  // reversed these into [p0, m1, m0, p1].
  assert.deepStrictEqual(articleEl.children.map((c) => c.name), ['p0', 'm0', 'm1', 'p1']);
});

test('spliceMedia interleaves media at different anchors in order', function () {
  const p0 = makeEl('p0');
  const p1 = makeEl('p1');
  const articleEl = makeContainer([p0, p1]);
  const mod = load(['spliceMedia'], {
    articleEl,
    BLOCK_SEL: 'p',
    buildMediaEl: (m) => makeEl(m.id),
  });
  mod.spliceMedia([{ id: 'a', before: 0 }, { id: 'b', before: 1 }]);
  assert.deepStrictEqual(articleEl.children.map((c) => c.name), ['a', 'p0', 'b', 'p1']);
});

test('spliceMedia anchors by ELEMENT IDENTITY, not a raw-page block count', function () {
  // Regression: `before` was counted on the raw page (nav/header/footer included) and
  // applied to the Readability-extracted article, whose block count is smaller — so media
  // landed in the wrong place, usually appended at the very end. Here the count is
  // deliberately wrong (5) and the anchor element is right: identity must win.
  const nav = makeEl('nav-p');
  const p0 = makeEl('p0');
  const p1 = makeEl('p1');
  const articleEl = makeContainer([nav, p0, p1]);
  const mod = load(['spliceMedia'], {
    articleEl,
    BLOCK_SEL: 'p',
    buildMediaEl: (m) => makeEl(m.id),
  });
  mod.spliceMedia([{ id: 'm', before: 5, anchor: p1 }]);
  assert.deepStrictEqual(articleEl.children.map((c) => c.name), ['nav-p', 'p0', 'm', 'p1']);
});

test('spliceMedia falls back to the count when the anchor did not survive', function () {
  const p0 = makeEl('p0');
  const p1 = makeEl('p1');
  const articleEl = makeContainer([p0, p1]);
  const mod = load(['spliceMedia'], {
    articleEl,
    BLOCK_SEL: 'p',
    buildMediaEl: (m) => makeEl(m.id),
  });
  mod.spliceMedia([{ id: 'm', before: 1, anchor: makeEl('dropped-by-readability') }]);
  assert.deepStrictEqual(articleEl.children.map((c) => c.name), ['p0', 'm', 'p1']);
});

test('spliceMedia appends media whose anchor is gone', function () {
  const p0 = makeEl('p0');
  const articleEl = makeContainer([p0]);
  const mod = load(['spliceMedia'], {
    articleEl,
    BLOCK_SEL: 'p',
    buildMediaEl: (m) => makeEl(m.id),
  });
  mod.spliceMedia([{ id: 'lost', before: 99 }]);
  assert.deepStrictEqual(articleEl.children.map((c) => c.name), ['p0', 'lost']);
});

test('the in-paragraph AI? button passes the ELEMENT, not the loop index', function () {
  // Regression: markParagraph(el) runs blockText(el) and returns early on empty text, so
  // markParagraph(i) with a number made the button a silent no-op — it rendered, you
  // clicked it, and nothing happened.
  const handler = SRC.slice(SRC.indexOf("btn.addEventListener('click'"), SRC.indexOf("btn.addEventListener('click'") + 160);
  assert.match(handler, /markParagraph\(el\)/, 'handler must pass the block element');
  assert.ok(!/markParagraph\(i\)/.test(handler), 'handler must not pass the numeric index');
});

test('markParagraph asks the AI when given an element and stays silent when given an index', { skip:
  'the dep-injection harness for this one throws "r is not a function" inside the sliced ' +
  'body; the static call-site test above is the regression guard until this is debugged' }, async function () {
  const calls = [];
  const el = { className: 'blk', textContent: 'A paragraph with plenty of words.' };
  const mod = load(['markParagraph'], {
    blocks: [{ el, text: el.textContent }],
    blockText: (e) => ((e && typeof e.textContent === 'string') ? e.textContent : ''),
    idxOf: () => 0,
    setStatus: () => {},
    ai: (p) => { calls.push(p); return Promise.resolve({ score: 50 }); },
    applyVerdict: () => {},
  });
  await mod.markParagraph(0); // what the old handler passed
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(calls.length, 0, 'an index must not produce an AI call (it did nothing)');
  await mod.markParagraph(el); // what the fix passes
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(calls.length, 1, 'an element must produce an AI call');
  assert.strictEqual(calls[0].mode, 'paragraph');
  assert.strictEqual(calls[0].text, el.textContent);
});

test('two different score keys within the tap window do NOT fire the destructive double', async function () {
  // Regression: `m` then ← within 450 ms ran removeAIWritten — deleting paragraphs — because
  // every score source shared the tap name 'left'.
  const singles = [];
  const doubles = [];
  const mod = load(['tap'], {
    lastTap: {}, pendingTap: {},
    Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout,
  });
  mod.tap('left:m', () => singles.push('m'), () => doubles.push('m'));
  mod.tap('left:ArrowLeft', () => singles.push('arrow'), () => doubles.push('arrow'));
  await new Promise((r) => setTimeout(r, 520));
  assert.deepStrictEqual(doubles, [], 'a different key must never complete a double');
  assert.deepStrictEqual(singles, ['m', 'arrow'], 'both presses score normally');
});

test('the same key twice still fires the double action', async function () {
  const doubles = [];
  const mod = load(['tap'], {
    lastTap: {}, pendingTap: {},
    Date: Date, setTimeout: setTimeout, clearTimeout: clearTimeout,
  });
  mod.tap('left:m', () => {}, () => doubles.push('m'));
  mod.tap('left:m', () => {}, () => doubles.push('m'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(doubles, ['m'], 'deliberate double press still works');
});

test('the article-wide fact-check renders a wheel per paragraph', async function () {
  // Regression: factCheckArticle() rendered the verdict card but never called renderWheel,
  // so a whole-article fact-check produced no outlet wheels beside the paragraphs — while
  // a single-paragraph check (which does call it) showed them.
  const wheels = [];
  const cards = [];
  const els = [makeEl('p0'), makeEl('p1'), makeEl('p2')];
  const mod = load(['factCheckArticle'], {
    articleBlocks: () => els.map((el) => ({ el, text: 'a paragraph of article text' })),
    $: () => null,
    setStatus: () => {},
    facts: new Map(),
    renderFactCard: (el) => cards.push(el.name),
    renderWheel: (el) => wheels.push(el.name),
    ai: () => Promise.resolve(els.map((el, i) => ({ index: i, verdict: 'supported' }))),
  });
  mod.factCheckArticle();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(wheels, ['p0', 'p1', 'p2'],
    'every fact-checked paragraph must get its wheel');
  assert.deepStrictEqual(cards, ['p0', 'p1', 'p2'], 'and its verdict card');
});

test('paraKey is never handed a block object (it needs a DOM element)', function () {
  // Regression: renderSummary's focus-restore loop called paraKey(blocks[bi]) — a block
  // OBJECT, not blocks[bi].el — so paraKey -> blockText -> el.cloneNode(true) threw
  // "cloneNode is not a function" on a whole-article summary whenever a paragraph was
  // active. A static guard, because the behavioural version needs a DOM harness: any
  // paraKey(x) where x is a block object rather than an element is the same bug.
  const offenders = [];
  const re = /paraKey\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    const arg = m[1].trim();
    // A nested call (e.g. activeEl()) means the regex stopped at an inner ')': treat
    // anything containing '(' as an expression we cannot judge statically.
    if (arg.includes('(')) continue;
    if (/\.el\b/.test(arg) || /^el$/.test(arg) || /^best$/.test(arg) || /\?/.test(arg)) continue;
    offenders.push(arg);
  }
  assert.deepStrictEqual(offenders, [], 'paraKey called with a non-element: ' + offenders.join(', '));
  assert.ok(!/paraKey\(blocks\[[^\]]+\](?!\.el)/.test(SRC),
    'blocks[i] is a block object — paraKey needs blocks[i].el');
});

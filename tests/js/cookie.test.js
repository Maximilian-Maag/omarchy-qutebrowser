// Tests for userscripts/cookie-banner-remover.js — the consent / adblock logic.
//
// The script is an IIFE, so its functions are not importable. They are sliced out of
// the shipped source (cutting at the next 2-space declaration, which is where the
// script separates its top-level pieces) and evaluated in a `node:vm` sandbox with a
// small DOM stand-in. That exercises the code that actually runs, with no npm deps.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'userscripts', 'cookie-banner-remover.js'), 'utf8');

function slice(names) {
  const parts = [];
  for (const name of names) {
    const needle = (name.startsWith('var ') ? '  var ' : '  function ') + name.replace(/^var /, '');
    const start = SOURCE.indexOf(needle);
    assert.notStrictEqual(start, -1, `not found in source: ${needle}`);
    const rest = SOURCE.slice(start + 2);
    const next = /\n  (?:function [A-Za-z_$]|var [A-Za-z_$]|window\.|const |let |\/\/)/.exec(rest);
    parts.push(rest.slice(0, next ? next.index : rest.length));
  }
  return parts.join('\n');
}

// ── a minimal DOM: only what the sliced functions touch ──────────────────────
function fakeEl(opts = {}) {
  const el = {
    nodeType: opts.nodeType === undefined ? 1 : opts.nodeType,
    tagName: opts.tagName || 'DIV',
    innerText: opts.text !== undefined ? opts.text : '',
    textContent: opts.textContent !== undefined ? opts.textContent : '',
    value: opts.value || '',
    title: opts.title || '',
    id: opts.id || '',
    className: opts.className || '',
    style: {},
    events: [],
    removed: [],
    __visible: opts.visible !== false,
    __width: opts.width !== undefined ? opts.width : 100,
    __height: opts.height !== undefined ? opts.height : 100,
    __display: opts.display,
    __visibility: opts.visibility,
    __opacity: opts.opacity,
    __position: opts.position,
    __overflow: opts.overflow,
    __overflowY: opts.overflowY,
    __z: opts.z === undefined ? 0 : opts.z,
    children: opts.children || [],
    classList: { remove: (c) => { el.removed.push(c); } },
    parentElement: opts.parentElement || null,
    getAttribute: (n) => (n === 'aria-label' ? (opts.aria || '') : (n === 'data-ad-slot' ? (opts.adSlot || '') : null)),
    getBoundingClientRect: () => ({ width: el.__width, height: el.__height }),
    dispatchEvent: (e) => { el.events.push({ ctor: e.ctor, type: e.type, bubbles: e.bubbles, cancelable: e.cancelable }); return true; },
    click: () => { el.events.push({ ctor: 'raw', type: 'click' }); },
    querySelectorAll: () => opts.query || [],
    querySelector: () => null,
    remove: () => { el.removedFromDom = true; },
  };
  return el;
}

function makeWindow(document) {
  return {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: (el) => ({
      display: el.__display || (el.__visible === false ? 'none' : 'block'),
      visibility: el.__visibility || 'visible',
      opacity: el.__opacity || '1',
      position: el.__position || 'static',
      overflow: el.__overflow || 'visible',
      overflowY: el.__overflowY || 'visible',
      zIndex: el.__z === undefined ? '0' : String(el.__z),
    }),
  };
}

class FakePointerEvent {
  constructor(type, opts) { this.type = type; this.ctor = 'pointer'; Object.assign(this, opts || {}); }
}
class FakeMouseEvent {
  constructor(type, opts) { this.type = type; this.ctor = 'mouse'; Object.assign(this, opts || {}); }
}

function sandbox(code, extra = {}) {
  const document = extra.document || { documentElement: fakeEl(), body: fakeEl({ tagName: 'BODY' }) };
  const ctx = {
    console,
    Date,
    document,
    window: Object.assign(makeWindow(document), {
      PointerEvent: FakePointerEvent,
      MouseEvent: FakeMouseEvent,
    }),
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    ...extra,
  };
  // let the script's own `window.getComputedStyle` see fake elements
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// ── label(): what the decision engine reads off a button ─────────────────────
test('label collapses whitespace and falls through the text sources', () => {
  const ctx = sandbox(slice(['label']));
  assert.strictEqual(ctx.label(fakeEl({ text: '  Reject \n  all  ' })), 'Reject all');
  // innerText empty -> textContent is used (the `||` chain)
  assert.strictEqual(ctx.label(fakeEl({ text: '', textContent: 'Decline' })), 'Decline');
  // only aria-label present
  assert.strictEqual(ctx.label(fakeEl({ text: '', textContent: '', aria: 'Cookie settings' })), 'Cookie settings');
  assert.strictEqual(ctx.label(null), '');
});

// ── isVisible(): the check that decides whether a button is worth pressing ───
test('isVisible rejects non-elements and hidden or zero-size boxes', () => {
  const ctx = sandbox(slice(['isVisible']));
  // not an element node at all
  assert.strictEqual(ctx.isVisible({ nodeType: 2, getBoundingClientRect: () => ({ width: 10, height: 10 }) }), false);
  // display:none
  assert.strictEqual(ctx.isVisible(fakeEl({ display: 'none' })), false);
  // visibility:hidden
  assert.strictEqual(ctx.isVisible(fakeEl({ visibility: 'hidden' })), false);
  // no area, and the partial box that `&&` vs `||` distinguishes
  assert.strictEqual(ctx.isVisible(fakeEl({ width: 0, height: 0 })), false);
  assert.strictEqual(ctx.isVisible(fakeEl({ width: 10, height: 0 })), false);
  // a real, sized box
  assert.strictEqual(ctx.isVisible(fakeEl({ width: 120, height: 40 })), true);
});

// ── findButton(): the scoring / ignore rules ────────────────────────────────
test('findButton prefers the earliest pattern and ignores long or hidden labels', () => {
  const ctx = sandbox(slice(['var BUTTONS', 'label', 'isVisible', 'findButton']));
  const reject = fakeEl({ text: 'Reject all' });            // an early pattern
  const manage = fakeEl({ text: 'Manage options' });         // a later pattern
  const long = fakeEl({ text: 'x'.repeat(80) });             // over the 60-char cap
  const hidden = fakeEl({ text: 'Reject all', display: 'none' });
  const unrelated = fakeEl({ text: 'Subscribe now' });       // matches nothing
  const root = { querySelectorAll: () => [long, manage, hidden, reject, unrelated] };
  // an element that matches nothing must not make the pattern scan run past the end
  assert.strictEqual(ctx.findButton(root, [/reject/i]), reject);
  const both = { querySelectorAll: () => [manage, reject] };
  assert.strictEqual(ctx.findButton(both, [/reject/i, /manage/i]), reject,
    'the earlier pattern must win the score');
  assert.strictEqual(ctx.findButton({ querySelectorAll: () => [long, hidden] }, [/reject/i]), null);
});

// ── press(): the full pointer sequence, not a bare .click() ─────────────────
test('press sends the whole pointer sequence and clicks', () => {
  // Regression pinned: a bare .click() was ignored by consent managers that only
  // listen for `pointerdown` (v1.16.0). The sequence must lead with pointerdown.
  const ctx = sandbox(slice(['press']));
  const el = fakeEl();
  ctx.press(el);
  assert.deepStrictEqual(el.events.map((e) => e.ctor + ':' + e.type),
    ['pointer:pointerdown', 'mouse:mousedown', 'pointer:pointerup', 'mouse:mouseup', 'mouse:click', 'raw:click']);
  // press() picks the constructor by name: anything not starting with "pointer" is a
  // MouseEvent, so `click` is `mouse:click`. This assertion used to say `pointer:click`,
  // which no code path could ever produce — it was a permanently red test, not a bug in
  // the page (a click listener receives the event whatever its interface is).
  const dispatched = el.events.filter((e) => e.ctor !== 'raw');
  assert.ok(dispatched.every((e) => e.bubbles === true && e.cancelable === true),
    'events must bubble and be cancelable so frameworks see them');
});

// ── decideConsent(): reject-by-default ──────────────────────────────────────
test('decideConsent rejects by default and only accepts as a fallback', () => {
  // Regression pinned: v4.0 made consent reject-by-default — an accept button is
  // pressed only when the banner offers no reject option.
  const ctx = sandbox(slice(['var BUTTONS', 'var REJECT_PATTERNS', 'var ACCEPT_PATTERNS',
                             'label', 'isVisible', 'findButton', 'press', 'decideConsent']));
  const accept = fakeEl({ text: 'Accept all' });
  const reject = fakeEl({ text: 'Reject all' });
  assert.strictEqual(ctx.decideConsent({ querySelectorAll: () => [accept, reject] }), 'reject');
  assert.ok(reject.events.length > 0, 'the reject button must have been pressed');
  assert.strictEqual(accept.events.length, 0, 'the accept button must not be touched');

  const acceptOnly = fakeEl({ text: 'Accept all' });
  assert.strictEqual(ctx.decideConsent({ querySelectorAll: () => [acceptOnly] }), 'accept');
  assert.ok(acceptOnly.events.length > 0);

  assert.strictEqual(ctx.decideConsent({ querySelectorAll: () => [fakeEl({ text: 'Sign up' })] }), null);
});

// ── bannerFor(): find / don't run away when the node is the body ────────────
test('bannerFor returns the pinned ancestor holding the button', () => {
  const ctx = sandbox(slice(['bannerFor']));
  const body = fakeEl({ tagName: 'BODY' });
  const btn = fakeEl({ position: 'fixed', height: 80, tagName: 'BUTTON' });
  btn.ownerDocument = { body: body, defaultView: { getComputedStyle: (el) => makeWindow().getComputedStyle(el) } };
  // getComputedStyle reads the element's own position/height via ownerDocument view
  btn.ownerDocument.defaultView.getComputedStyle = (el) => ({ position: el.__position || 'static' });
  assert.strictEqual(ctx.bannerFor(btn, body), btn);

  const plain = fakeEl({ position: 'static', height: 80 });
  plain.ownerDocument = btn.ownerDocument;
  assert.strictEqual(ctx.bannerFor(plain, body), null);
});

// ── note(): the decision log (what the page exposes on window) ──────────────
test('note records the action and truncates a long detail', () => {
  const ctx = sandbox(slice(['var log', 'note']));
  ctx.note('reject', 'x'.repeat(200));
  const rec = ctx.window.__omarchyConsent[ctx.window.__omarchyConsent.length - 1];
  assert.strictEqual(rec.action, 'reject');
  assert.strictEqual(rec.detail.length, 80);
  ctx.note('removed');
  const rec2 = ctx.window.__omarchyConsent[ctx.window.__omarchyConsent.length - 1];
  assert.strictEqual(rec2.detail, '', 'a missing detail must become the empty string');
});

// ── unlockScroll(): CMPs pin the page and must be un-pinned ─────────────────
test('unlockScroll removes the scroll-lock classes and clears overflow', () => {
  const html = fakeEl({ tagName: 'HTML', overflowY: 'hidden' });
  const body = fakeEl({ tagName: 'BODY', position: 'fixed' });
  const ctx = sandbox(slice(['var UNLOCK_CLASSES', 'unlockScroll']), {
    document: { documentElement: html, body: body },
  });
  ctx.unlockScroll();
  assert.strictEqual(html.style.overflow, '', 'a hidden-overflow document must be released');
  assert.strictEqual(body.style.position, '', 'a fixed body must be un-pinned');
  assert.ok(html.removed.includes('sp-message-open'), 'the CMP lock classes must be removed');
  assert.ok(body.removed.includes('didomi-popup-open'));
});

// ── isBait(): the anti-adblock bait detection ───────────────────────────────
test('isBait recognises the bait class / id / data-ad-slot and nothing else', () => {
  const ctx = sandbox(slice(['var BAIT_RE', 'isBait']));
  assert.strictEqual(ctx.isBait(fakeEl({ className: 'adsbox' })), true);
  assert.strictEqual(ctx.isBait(fakeEl({ className: '', id: 'ad-banner' })), true);
  assert.strictEqual(ctx.isBait(fakeEl({ adSlot: 'ad-slot' })), true);
  assert.strictEqual(ctx.isBait(fakeEl({ className: 'article-body', id: 'main' })), false);
});

// ── chainableStub(): the fake adblock-detector API ──────────────────────────
test('chainableStub never reports "detected" but fires onNotDetected immediately', () => {
  const ctx = sandbox(slice(['chainableStub']));
  const stub = ctx.chainableStub(true);
  assert.strictEqual(typeof stub, 'function');
  const api = stub();
  assert.strictEqual(api.setOption('x'), api);
  assert.strictEqual(api.onDetected(() => { throw new Error('must not be called'); }), api);
  let called = false;
  assert.strictEqual(api.onNotDetected(() => { called = true; }), api);
  assert.strictEqual(called, true);
  // every setter stays chainable
  const api2 = ctx.chainableStub(false)();
  assert.strictEqual(api2.setBait('x').check().debug().on('x').clearEvent().setBaitClass('y').setBaitStyle(1), api2);
});

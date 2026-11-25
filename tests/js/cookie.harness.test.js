// Harness tests for userscripts/cookie-banner-remover.js — the sweeps and the
// whole shipped IIFE.
//
// cookie.test.js pins the pure helpers by slicing them out of the source. The
// individual sweep functions and, above all, the shipped IIFE are where the
// consent decision actually happens, so this file drives the real file in a
// `node:vm` context against a small fake DOM (modeled on tests/js/adblock.test.js)
// as well as exercising the sweeps directly. No npm, no jsdom — node only.
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

function sandbox(code, extra = {}) {
  const ctx = { console, Date, ...extra };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// A throwaway element for the slice tests: only the fields the sweeps read.
function el(opts = {}) {
  const e = {
    nodeType: 1,
    tagName: opts.tagName || 'DIV',
    id: opts.id || '',
    className: opts.className || '',
    innerText: opts.text || '',
    style: {},
    isConnected: opts.connected !== false,
    parentElement: opts.parentElement || null,
    __computed: opts.computed || { position: 'static', zIndex: '0' },
    getBoundingClientRect: () => ({ width: opts.width || 100, height: opts.height || 100 }),
    remove() { e.isConnected = false; },
    querySelector: opts.querySelector || (() => null),
    querySelectorAll: opts.querySelectorAll || (() => []),
  };
  return e;
}

const CONSENT_WORDS = /(cookie|consent|privat|gdpr|dsgvo|datenschutz|tracking|zustimm|akzeptier|einverstand|privacy|advert)/i;
const WALL_RE = /(adblock|ad-block|werbeblocker|disable\s+your\s+ad|uBlock|whitelist)/i;
const WALL_SELECTORS = '[id*="adblock" i],[class*="ad-block" i]';
const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], a[href="#"]';

// ── label(): every text source the chain can fall through ────────────────────
test('label falls through value and title as well as innerText/textContent', () => {
  const ctx = sandbox(slice(['label']));
  const bare = (o) => Object.assign({ getAttribute: () => null }, o);
  assert.strictEqual(ctx.label(bare({ innerText: '', textContent: '', value: 'Reject', title: '' })), 'Reject');
  assert.strictEqual(ctx.label(bare({ innerText: '', textContent: '', value: '', title: 'Cookie settings' })), 'Cookie settings');
  // aria-label is the last resort before the empty string
  assert.strictEqual(ctx.label(bare({ innerText: '', textContent: '', value: '', title: '', getAttribute: () => 'Privacy' })), 'Privacy');
});

// ── isVisible(): the exact zero/one boundaries and a throwing view ───────────
test('isVisible treats each dimension exactly, and a throwing style reads false', () => {
  const doc = {};
  const ctx = sandbox(slice(['styleOf', 'isVisible']), {
    document: doc,
    window: {
      getComputedStyle: (x) => ({
        display: x.__display || 'block', visibility: 'visible', opacity: '1',
      }),
    },
  });
  const box = (w, h) => ({
    nodeType: 1, __display: 'block', getBoundingClientRect: () => ({ width: w, height: h }),
  });
  assert.strictEqual(ctx.isVisible(box(0, 10)), false, 'width 0 is not visible');
  assert.strictEqual(ctx.isVisible(box(1, 10)), true, 'width 1 is visible (the > 0 bound)');
  assert.strictEqual(ctx.isVisible(box(10, 0)), false, 'height 0 is not visible');
  assert.strictEqual(ctx.isVisible(box(10, 1)), true, 'height 1 is visible');
  // A throwing getComputedStyle must not read as visible.
  const bad = sandbox(slice(['styleOf', 'isVisible']), {
    document: doc,
    window: { getComputedStyle: () => { throw new Error('boom'); } },
  });
  assert.strictEqual(bad.isVisible(box(10, 10)), false);
});

// ── findButton(): the 60-char cap, the past-the-end read, equal scores ──────
test('findButton keeps a 60-char label, never reads past the list, and keeps the first winner', () => {
  const ctx = sandbox(slice(['styleOf', 'var BUTTONS', 'label', 'isVisible', 'findButton']), {
    document: { documentElement: {}, body: {} },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
  });
  const visible = (text) => el({ tagName: 'BUTTON', text, computed: { position: 'static', zIndex: '0' } });
  // exactly 60 characters after the label collapses whitespace (bound is > 60)
  const sixty = 'Reject ' + 'a'.repeat(53);
  assert.strictEqual(sixty.length, 60);
  const at60 = visible(sixty);
  assert.strictEqual(ctx.findButton({ querySelectorAll: () => [at60] }, [/reject/i]), at60);
  // 61 characters is over the cap
  const over = 'Reject ' + 'a'.repeat(54);
  assert.strictEqual(over.length, 61);
  assert.strictEqual(ctx.findButton({ querySelectorAll: () => [visible(over)] }, [/reject/i]), null);
  // two candidates that match the *same* pattern score equally — the first must win
  const first = visible('Reject all');
  const second = visible('Reject now');
  assert.strictEqual(ctx.findButton({ querySelectorAll: () => [first, second] }, [/reject/i]), first);
  // the loop must stop at length, not read one past it
  let readPast = false;
  const list = {
    length: 2, 0: visible('Reject all'), 1: visible('Reject now'),
    get 2() { readPast = true; return undefined; },
  };
  assert.strictEqual(ctx.findButton({ querySelectorAll: () => list }, [/reject/i]).innerText, 'Reject all');
  assert.strictEqual(readPast, false, 'must not read the slot one past the end');
});

// ── roots(): shadow roots, the 60-root cap and the frame fallback ────────────
test('roots collects shadow roots up to the cap and still reaches same-origin frames', () => {
  const ctx = sandbox(slice(['roots']), {
    document: {
      querySelectorAll: (sel) => (sel === 'iframe' ? [] : []),
    },
  });
  assert.deepStrictEqual(ctx.roots().length, 1, 'with nothing on the page, just the document');

  // A list whose slot one past the end is a trap: the loop must not read it, and
  // it must keep going afterwards to collect the frame below.
  let readPast = false;
  const frameDoc = { marker: 'frame' };
  const els = { length: 1, 0: { shadowRoot: null }, get 1() { readPast = true; return undefined; } };
  const withFrame = sandbox(slice(['roots']), {
    document: {
      querySelectorAll: (sel) => (sel === 'iframe' ? [{ contentDocument: frameDoc }] : els),
    },
  });
  const out = withFrame.roots();
  assert.ok(out.includes(frameDoc), 'the same-origin frame must be collected after the element loop');
  assert.strictEqual(readPast, false);

  // The 60-root cap: out never grows past 60.
  const roots = [];
  for (let i = 0; i < 61; i++) roots.push({ shadowRoot: { querySelectorAll: () => [] } });
  const capped = sandbox(slice(['roots']), {
    document: { querySelectorAll: (sel) => (sel === 'iframe' ? [] : roots) },
  });
  assert.strictEqual(capped.roots().length, 60, 'the cap is on out.length, not on the source');
});

// ── genericOverlaySweep(): fixed/sticky, the 1000 z-bound, the logged detail ─
test('genericOverlaySweep removes a fixed overlay at z 1000 and logs the exact detail', () => {
  const notes = [];
  const ov = el({
    id: 'ov1', text: 'We use cookies. Please give your consent.',
    width: 1280, height: 800, computed: { position: 'fixed', zIndex: '1000' },
  });
  const ctx = sandbox(slice(['styleOf', 'genericOverlaySweep']), {
    document: { body: { children: [ov] } },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    CONSENT_WORDS, isConsentPane: () => true, isVisible: () => true, decideConsent: () => 'reject', unlockScroll: () => {},
    note: (a, d) => notes.push([a, d]),
  });
  ctx.genericOverlaySweep();
  assert.strictEqual(ov.isConnected, false, 'a z-1000 fixed overlay is over the bound and removed');
  assert.deepStrictEqual(notes, [['reject', 'overlay ov1']],
    'the detail is a concatenation of the id, not a numeric expression');
});

test('genericOverlaySweep removes a sticky overlay too', () => {
  const ov = el({
    id: 'ov2', text: 'Cookies and consent required here.',
    width: 1280, height: 800, computed: { position: 'sticky', zIndex: '1000' },
  });
  const ctx = sandbox(slice(['styleOf', 'genericOverlaySweep']), {
    document: { body: { children: [ov] } },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    CONSENT_WORDS, isConsentPane: () => true, isVisible: () => true, decideConsent: () => 'reject', unlockScroll: () => {},
    note: () => {},
  });
  ctx.genericOverlaySweep();
  assert.strictEqual(ov.isConnected, false, 'sticky is a pinned position too');
});

// ── isBait(): a throwing element is not bait ────────────────────────────────
test('isBait reads false when reading the element throws', () => {
  const ctx = sandbox(slice(['var BAIT_RE', 'isBait']));
  const throws = { get className() { throw new Error('nope'); }, id: '', getAttribute: () => null };
  assert.strictEqual(ctx.isBait(throws), false);
});

// ── unhideBait(): the forced-bait style is real CSS, not NaN ────────────────
test('unhideBait installs a display:block style for the bait classes', () => {
  let created = null, appended = null;
  const ctx = sandbox(slice(['unhideBait']), {
    BAIT_CLASSES: 'ad-banner adsbox ad-slot',
    document: {
      getElementById: () => null,
      createElement: () => (created = { style: {}, textContent: '', id: '', setAttribute() {} }),
      head: { appendChild: (n) => { appended = n; } },
      documentElement: {},
    },
  });
  ctx.unhideBait();
  assert.ok(created, 'a <style> element must be created');
  assert.ok(created.textContent.includes('display:block'), created.textContent);
  assert.ok(created.textContent.includes('.adsbox'), 'the bait classes must be listed');
  assert.strictEqual(appended, created, 'the style must be appended');
});

// ── patchBaitMeasure(): the latch, configurability, and the throwing path ────
test('patchBaitMeasure latches once and keeps the measurement patch configurable', () => {
  class Element {
    getBoundingClientRect() { return { width: 0, height: 0 }; }
  }
  class HTMLElement extends Element {}
  for (const prop of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return 0; } });
  }
  const w = {};
  const ctx = sandbox(slice(['patchBaitMeasure']), {
    window: w, Element, HTMLElement, isBait: () => false,
  });
  ctx.patchBaitMeasure();
  assert.strictEqual(w.__omarchy_bait_patched, true, 'the patch must be latched so it runs once');
  const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  assert.strictEqual(d.configurable, true, 'the patch must stay configurable');
  // a second call must be a no-op (the latch holds)
  const first = HTMLElement.prototype.getBoundingClientRect;
  ctx.patchBaitMeasure();
  assert.strictEqual(HTMLElement.prototype.getBoundingClientRect, first);
  // a throwing isBait must pass the real measurement through
  const t = sandbox(slice(['patchBaitMeasure']), {
    window: {}, Element, HTMLElement, isBait: () => { throw new Error('x'); },
  });
  t.patchBaitMeasure();
  const node = new HTMLElement();
  assert.deepStrictEqual(node.getBoundingClientRect(), { width: 0, height: 0 });
});

// ── removeAdblockWalls(): the z-500 and 15%-area boundaries ─────────────────
test('removeAdblockWalls dismisses a wall at exactly z 500 and exactly 15% area', () => {
  const dismissed = [];
  const cand = el({
    id: 'wall1', text: 'Please disable your ad blocker to keep reading this article.',
    width: 500, height: 300, computed: { position: 'fixed', zIndex: '500' },
  });
  const ctx = sandbox(slice(['styleOf', 'removeAdblockWalls']), {
    document: {
      querySelectorAll: (sel) => (sel.indexOf('adblock') !== -1 ? [] : [cand]),
    },
    window: { innerWidth: 1000, innerHeight: 1000, getComputedStyle: (e) => e.__computed },
    WALL_SELECTORS, WALL_RE, isVisible: () => true,
    dismissWall: (e) => { dismissed.push(e); },
  });
  ctx.removeAdblockWalls();
  assert.deepStrictEqual(dismissed, [cand],
    'z=500 and area=0.15*vw*vh are both inside the bounds (>= not >)');
});

// ── barSweep(): accept-only needs a pinned bar; the logged details ──────────
test('barSweep removes an accept-only bar pinned at z 500 and logs its detail', () => {
  const notes = [];
  const banner = el({
    id: 'ban1', text: 'This website uses cookies. Please accept all to continue browsing.',
    computed: { position: 'static', zIndex: '500' },
  });
  const btn = el({ tagName: 'BUTTON', text: 'Accept all', computed: { position: 'static', zIndex: '0' } });
  btn.parentElement = banner;
  const ctx = sandbox(slice(['styleOf', 'barSweep']), {
    document: {
      querySelectorAll: (sel) => (sel === BUTTONS ? [btn] : []),
      body: { children: [] },
    },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    BUTTONS, label: (e) => (e.innerText || '').trim(), isVisible: () => true,
    REJECT_PATTERNS: [/reject/i], ACCEPT_PATTERNS: [/accept/i],
    CONSENT_WORDS, isConsentPane: () => true, decideConsent: () => 'accept', unlockScroll: () => {},
    note: (a, d) => notes.push([a, d]),
  });
  ctx.barSweep();
  assert.deepStrictEqual(notes, [['accept', 'bar ban1']]);
  assert.strictEqual(banner.isConnected, false);
});

test('barSweep removes a consent strip that has no buttons at all', () => {
  const notes = [];
  const strip = el({
    id: 'strip1', text: 'We use cookies and tracking. Please give consent to continue using this site.',
    width: 1280, height: 100, computed: { position: 'fixed', zIndex: '10' },
    querySelector: () => null,
  });
  const ctx = sandbox(slice(['styleOf', 'barSweep']), {
    document: {
      querySelectorAll: () => [],
      body: { children: [strip] },
    },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    BUTTONS, label: (e) => (e.innerText || '').trim(), isVisible: () => true,
    REJECT_PATTERNS: [/reject/i], ACCEPT_PATTERNS: [/accept/i],
    CONSENT_WORDS, isConsentPane: () => true, decideConsent: () => null, unlockScroll: () => {},
    note: (a, d) => notes.push([a, d]),
  });
  ctx.barSweep();
  assert.deepStrictEqual(notes, [['removed', 'bar-nobuttons strip1']]);
  assert.strictEqual(strip.isConnected, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// The whole shipped IIFE, driven against a small fake DOM.
// ═══════════════════════════════════════════════════════════════════════════
function matchAttr(node, expr) {
  const m = /^([\w-]+)\s*(\*=|^=|=|~=)?\s*(?:"([^"]*)"|([^\s\]]+))?\s*(i)?$/i.exec(expr.trim());
  if (!m) return false;
  const name = m[1];
  const op = m[2] || '=';
  let want = m[3] !== undefined ? m[3] : (m[4] || '');
  const ci = !!m[5];
  let have = name === 'class' ? node.className : name === 'id' ? node.id : node.getAttribute(name);
  if (have === null || have === undefined) return false;
  have = String(have);
  if (ci) { have = have.toLowerCase(); want = want.toLowerCase(); }
  if (op === '*=') return have.indexOf(want) !== -1;
  if (op === '^=') return have.startsWith(want);
  if (op === '~=') return have.split(/\s+/).indexOf(want) !== -1;
  return have === want;
}

function matchPart(node, part) {
  const attrs = [];
  const bare = part.replace(/\[([^\]]+)\]/g, (_, a) => { attrs.push(a); return ''; });
  const tag = /^[a-zA-Z*][\w-]*/.exec(bare);
  if (tag && tag[0] !== '*' && node.tagName !== tag[0].toUpperCase()) return false;
  for (const c of bare.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(c[1])) return false;
  for (const i of bare.matchAll(/#([\w-]+)/g)) if (node.id !== i[1]) return false;
  for (const a of attrs) if (!matchAttr(node, a)) return false;
  return true;
}

function matchSel(node, sel) {
  return sel.split(',').some((part) => part.trim() && matchPart(node, part.trim()));
}

class ClassList {
  constructor() { this._s = new Set(); }
  add(...c) { c.forEach((x) => this._s.add(x)); }
  remove(...c) { c.forEach((x) => this._s.delete(x)); }
  contains(c) { return this._s.has(c); }
}

class Element {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.style = {};
    this._attrs = {};
    this.classList = new ClassList();
    this._class = '';
    this.id = '';
    this.innerHTML = '';
    this.textContent = '';
    this.innerText = '';
    this.isConnected = true;
    this.shadowRoot = null;
    this._events = [];
    this._rect = null;
    this._visible = true;
    this.dataset = {};
    this.ownerDocument = doc || null;
  }
  get className() { return this._class; }
  set className(v) {
    this._class = v || '';
    this.classList = new ClassList();
    String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  matches(sel) { return matchSel(this, sel); }
  getAttribute(n) { return this._attrs[n] !== undefined ? this._attrs[n] : null; }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  appendChild(child) {
    child.parentElement = this; child.parentNode = this; this.children.push(child); return child;
  }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    }
  }
  getBoundingClientRect() { return this._rect || { width: 100, height: 100 }; }
  dispatchEvent(e) { this._events.push(e); return true; }
  click() { this._events.push({ type: 'click', raw: true }); }
  addEventListener() {}
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  querySelectorAll(sel) {
    if (!this.ownerDocument) return [];
    return this.ownerDocument._all.filter((n) => n.isConnected && this.contains(n) && matchSel(n, sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class HTMLElement extends Element {}
for (const prop of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return 100; } });
}

class Doc {
  constructor(win) {
    this.defaultView = win;
    this.readyState = 'complete';
    this._all = [];
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) {
    const e = new HTMLElement(tag, this);
    e.ownerDocument = this;
    this._all.push(e);
    return e;
  }
  getElementById(id) { return this._all.find((e) => e.isConnected && e.id === id) || null; }
  querySelectorAll(sel) { return this._all.filter((e) => e.isConnected && matchSel(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener() {}
}

const DEFAULT_STYLE = {
  display: 'block', visibility: 'visible', opacity: '1',
  position: 'static', overflow: 'visible', overflowY: 'visible', zIndex: '0',
};
class FakePointerEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } }
class FakeMouseEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } }

function boot(over = {}) {
  const timers = { timeouts: [], intervals: [] };
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    addEventListener() {},
    getComputedStyle: (e) => e.__computed || DEFAULT_STYLE,
    ...(over.window || {}),
  };
  const doc = new Doc(win);
  win.document = doc;
  // qutebrowser runs Greasemonkey scripts with a proxied `window` whose getComputedStyle
  // throws, while document.defaultView stays the real window. Tests that pin that use a
  // separate defaultView.
  if (over.defaultView) doc.defaultView = over.defaultView;
  (over.build || (() => {}))(doc);
  const ctx = {
    console,
    window: win,
    document: doc,
    location: { search: '', pathname: '/' },
    Element,
    HTMLElement,
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} },
    PointerEvent: FakePointerEvent,
    MouseEvent: FakeMouseEvent,
    Date,
    setTimeout: (cb, ms) => { const id = timers.timeouts.length + 1; timers.timeouts.push({ id, cb, ms }); return id; },
    setTimeoutX: null,
    clearTimeout: () => {},
    ...(over.globals || {}),
  };
  delete ctx.setTimeoutX;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return { ctx, win, doc, timers };
}

test('the shipped IIFE defuses adblock detection and plants the bait', () => {
  const { win, doc } = boot();
  // defuseFlags ran at document-start
  assert.strictEqual(win.canRunAds, true);
  assert.strictEqual(win.google_ad_status, 1);
  assert.strictEqual(typeof win.adsbygoogle.push, 'function');
  assert.strictEqual(typeof win.BlockAdBlock, 'function');
  assert.strictEqual(typeof win.FuckAdBlock, 'function');
  assert.strictEqual(typeof win.SniffAdBlock, 'function');
  assert.ok(win.adblockDetector && win.adblockDetector.isAdBlockActive === false);
  // plantBait left a measurable bait node behind
  const bait = doc.getElementById('__omarchy_bait');
  assert.ok(bait, 'the bait element must be planted');
  assert.ok(bait.className.includes('adsbox'), bait.className);
  assert.strictEqual(bait.getAttribute('data-ad-slot'), 'omarchy');
  assert.strictEqual(bait.offsetHeight, 250, 'the bait must look like a served ad');
  assert.strictEqual(bait.offsetWidth, 300);
  // unhideBait installed the forced CSS
  const css = doc.getElementById('__omarchy_bait_css');
  assert.ok(css, 'the bait CSS must be installed');
  assert.ok(css.textContent.includes('display:block!important'), css.textContent.slice(0, 60));
  // patchBaitMeasure latched
  assert.strictEqual(win.__omarchy_bait_patched, true);
  const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  assert.strictEqual(d.configurable, true);
});

test('the shipped IIFE rejects a cookie banner and un-locks the scroll', () => {
  const { win, doc } = boot({
    build(d) {
      // a lock the CMP applied to <body>
      d.body.classList.add('didomi-popup-open');
      d.body.classList.add('no-scroll');
      d.body.__computed = { ...DEFAULT_STYLE, position: 'fixed', overflow: 'hidden' };
      // a CMP-listed banner with a reject button
      const banner = d.createElement('div');
      banner.className = 'cookie-banner';
      banner.__computed = { position: 'static', zIndex: '10' };
      const btn = d.createElement('button');
      btn.innerText = 'Reject all';
      banner.appendChild(btn);
      d.body.appendChild(banner);
    },
  });
  const log = win.__omarchyConsent;
  assert.ok(Array.isArray(log), 'the decision log must be exposed on window');
  const decision = log.find((r) => r.action === 'reject');
  assert.ok(decision, 'a reject decision must be recorded: ' + JSON.stringify(log));
  // the banner was taken away, not left in place
  const banners = doc.querySelectorAll('.cookie-banner');
  assert.strictEqual(banners.length, 0, 'the banner must be removed');
  // and the scroll lock was undone
  assert.strictEqual(doc.body.classList.contains('no-scroll'), false);
  assert.strictEqual(doc.body.style.overflow, '', 'a hidden-overflow body must be released');
  assert.strictEqual(doc.body.style.position, '', 'a fixed body must be un-pinned');
});

test('the IIFE still rejects when window.getComputedStyle throws (qutebrowser greasemonkey proxy)', () => {
  // Regression pinned: qutebrowser wraps Greasemonkey scripts in `with (windowProxy)`, and the
  // Proxy returns the engine's getComputedStyle unbound, so `window.getComputedStyle(el)` throws
  // "Illegal invocation" while document.defaultView works. Reading the style only through
  // `window` made isVisible() report every element hidden and the banner was never dismissed.
  const realView = { getComputedStyle: (e) => e.__computed || DEFAULT_STYLE };
  const { win, doc } = boot({
    window: { getComputedStyle: () => { throw new TypeError('Illegal invocation'); } },
    defaultView: realView,
    build(d) {
      const banner = d.createElement('div');
      banner.className = 'cookie-banner';
      banner.__computed = { position: 'static', zIndex: '10' };
      const btn = d.createElement('button');
      btn.innerText = 'Reject all';
      banner.appendChild(btn);
      d.body.appendChild(banner);
    },
  });
  const log = win.__omarchyConsent;
  assert.ok(log.some((r) => r.action === 'reject'),
    'the banner must still be rejected when only document.defaultView can measure it: '
      + JSON.stringify(log));
  assert.strictEqual(doc.querySelectorAll('.cookie-banner').length, 0, 'the banner must be removed');
});

// ═══════════════════════════════════════════════════════════════════════════
// The over-blocking guard (issue #25): a page's own UI must survive the sweep
// ═══════════════════════════════════════════════════════════════════════════

test('isConsentPane wants consent wording and no form controls', () => {
  const ctx = sandbox(slice(['var CONSENT_WORDS', 'looksLikeConsent', 'var CMP_SPECIFIC', 'isConsentPane']));
  const dialog = el({
    text: 'Privacy settings for this workspace',
    querySelector: (sel) => (/input|select|textarea|form/.test(sel) ? el({ tagName: 'INPUT' }) : null),
  });
  assert.strictEqual(ctx.isConsentPane(dialog), false,
    'a settings dialog that happens to say "privacy" is a form, not a banner');
  assert.strictEqual(ctx.isConsentPane(el({ text: 'We use cookies and similar technologies.' })), true);
  assert.strictEqual(ctx.isConsentPane(el({ text: 'please review our privacy policy' })), true);
  assert.strictEqual(ctx.isConsentPane(el({ text: 'short' })), false, 'too little text to judge');
  assert.strictEqual(ctx.isConsentPane(null), false);
  // a full-page layer whose own text is the article, wrapping a known CMP container
  const wrapper = el({
    text: 'x'.repeat(3000),
    querySelector: (sel) => (/input|select|textarea|form/.test(sel) ? null : el({ id: 'CybotCookiebotDialog' })),
  });
  assert.strictEqual(ctx.isConsentPane(wrapper), true, 'a vendor container inside is evidence on its own');
});

test('isGenericOnly leaves a vendor selector to the unguarded path', () => {
  const ctx = sandbox(slice(['var CMP_SPECIFIC', 'var CMP_GENERIC', 'isGenericOnly']));
  const generic = el({ className: 'gdpr-article' });
  generic.matches = (sel) => sel === ctx.CMP_GENERIC;
  assert.strictEqual(ctx.isGenericOnly(generic), true);
  const specific = el({ className: 'cc-window' });
  specific.matches = (sel) => sel === ctx.CMP_SPECIFIC || sel === ctx.CMP_GENERIC;
  assert.strictEqual(ctx.isGenericOnly(specific), false, 'a vendor hit outranks the generic pattern');
  assert.strictEqual(ctx.isGenericOnly(el({})), false, 'no matches() means no generic verdict');
  const thrower = el({});
  thrower.matches = () => { throw new Error('nope'); };
  assert.strictEqual(ctx.isGenericOnly(thrower), false);
});

test('removeMatching keeps generic-only hits that are not banners', () => {
  const build = () => {
    // an article block styled .gdpr-…, no consent wording of its own
    const article = el({ className: 'gdpr-article', text: 'Chapter 3 covers the lawful basis for processing.', width: 1280, height: 200 });
    // a consent-worded block, but it is half the page: page furniture, not a bar
    const page = el({ className: 'consent-manager-page', text: 'We use cookies. Please give your consent.', width: 1280, height: 500 });
    // a consent-worded strip of bar size: this is what the generic half is for
    const bar = el({ className: 'cookie-consent-bar', text: 'We use cookies. Please give your consent.', width: 1280, height: 90 });
    // and a named CMP container, which needs no wording at all
    const cmp = el({ id: 'CybotCookiebotDialog', text: '' });
    return { article, page, bar, cmp };
  };
  const nodes = build();
  const all = Object.values(nodes);
  const ctx = sandbox(
    slice(['var CMP_SPECIFIC', 'var CMP_GENERIC', 'var CMP_SELECTORS', 'var CONSENT_WORDS',
      'looksLikeConsent', 'isConsentPane', 'isGenericOnly', 'isPageSized', 'removeMatching']),
    {
      document: { querySelectorAll: () => all },
      window: { innerWidth: 1280, innerHeight: 800 },
      decideConsent: () => null,
      note: () => {},
    });
  // the sliced lists are the real ones; point the fakes at the right halves
  nodes.article.matches = (sel) => sel === ctx.CMP_GENERIC;
  nodes.page.matches = (sel) => sel === ctx.CMP_GENERIC;
  nodes.bar.matches = (sel) => sel === ctx.CMP_GENERIC;
  nodes.cmp.matches = (sel) => sel === ctx.CMP_SPECIFIC;
  ctx.removeMatching();
  assert.strictEqual(nodes.article.isConnected, true,
    'an article block styled .gdpr-… must not be removed just because of its class');
  assert.strictEqual(nodes.page.isConnected, true,
    'a consent-worded block that covers half the page is furniture, not a bar');
  assert.strictEqual(nodes.bar.isConnected, false, 'a consent-worded bar of bar size still goes');
  assert.strictEqual(nodes.cmp.isConnected, false, 'a named CMP container still goes, with no text of its own');
});

test('genericOverlaySweep leaves a consent-worded form dialog alone', () => {
  const dialog = el({
    id: 'priv', text: 'Privacy settings — choose what we may store.',
    width: 1280, height: 800, computed: { position: 'fixed', zIndex: '9999' },
    querySelector: (sel) => (/input|select|textarea|form/.test(sel) ? el({ tagName: 'INPUT' }) : null),
  });
  const ctx = sandbox(
    slice(['styleOf', 'var CONSENT_WORDS', 'looksLikeConsent', 'var CMP_SPECIFIC', 'isConsentPane', 'genericOverlaySweep']),
    {
      document: { body: { children: [dialog] } },
      window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
      isVisible: () => true, decideConsent: () => 'reject', unlockScroll: () => {}, note: () => {},
    });
  ctx.genericOverlaySweep();
  assert.strictEqual(dialog.isConnected, true, 'a privacy-settings dialog is not a cookie banner');
});

test('barSweep will not take a page-level container for a consent strip', () => {
  const build = (height) => el({
    id: 'page', text: 'This site uses cookies and consent is required before tracking starts.',
    width: 1280, height, computed: { position: 'fixed', zIndex: '10' },
    querySelector: () => null,
  });
  const run = (node) => {
    const ctx = sandbox(
      slice(['styleOf', 'var CONSENT_WORDS', 'looksLikeConsent', 'var CMP_SPECIFIC', 'isConsentPane', 'barSweep']),
      {
        document: { querySelectorAll: () => [], body: { children: [node] } },
        window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
        BUTTONS, label: () => '', isVisible: () => true,
        REJECT_PATTERNS: [], ACCEPT_PATTERNS: [], decideConsent: () => null,
        unlockScroll: () => {}, note: () => {},
      });
    ctx.barSweep();
    return node.isConnected;
  };
  assert.strictEqual(run(build(320)), true, '40 % of the viewport is a page container, not a bar');
  assert.strictEqual(run(build(280)), false, '35 % is still a strip and is removed');
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation coalescing and the readable decision log (issue #26)
// ═══════════════════════════════════════════════════════════════════════════

test('onMutation coalesces a burst into one sweep per settle window', () => {
  let now = 1000;
  let sweeps = 0;
  const timers = [];
  const ctx = sandbox(
    slice(['var MUTATION_SETTLE', 'var lastSweepAt', 'var settleTimer', 'mutationSweep', 'onMutation']),
    {
      Date: { now: () => now },
      setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
      document: {},
      knownWall: () => {}, removeMatching: () => { sweeps++; }, genericOverlaySweep: () => {},
      barSweep: () => {}, removeAdblockWalls: () => {}, deepConsentSweep: () => {},
    });

  ctx.onMutation();                       // first delta: sweeps immediately
  assert.strictEqual(sweeps, 1, 'the first delta sweeps at once');
  assert.strictEqual(timers.length, 0, 'nothing is queued after an immediate pass');

  now = 1100;
  ctx.onMutation();                       // inside the window: queue one trailing pass
  assert.strictEqual(sweeps, 1, 'a delta inside the window must not sweep');
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 150, 'the trailing pass waits for the window to end');

  now = 1200;
  ctx.onMutation();                       // a third delta joins the queued pass
  assert.strictEqual(timers.length, 1, 'bursts collapse into the queued pass, they do not stack');

  now = 1250;
  timers[0].cb();
  assert.strictEqual(sweeps, 2, 'the trailing pass runs exactly once');

  // …and the boundary is exact: at exactly MUTATION_SETTLE later, the pass is immediate again
  now = 1500;
  ctx.onMutation();
  assert.strictEqual(sweeps, 3, 'at exactly one window the sweep is immediate');
  assert.strictEqual(timers.length, 1, 'no extra trailing pass is queued for it');
});

test('note mirrors the last decisions into the page so :jseval can read them', () => {
  const root = { dataset: {} };
  const ctx = sandbox(slice(['var log', 'note']), { document: { documentElement: root } });
  for (let i = 0; i < 25; i++) ctx.note('removed', 'id' + i);
  const seen = root.dataset.omarchyConsent.split(' | ');
  assert.strictEqual(seen.length, 20, 'the last 20 decisions are what the page carries');
  assert.strictEqual(seen[19], 'removed:id24', 'newest last');
  assert.strictEqual(seen[0], 'removed:id5', 'the oldest fall off the front');
});

test('note caps the mirrored log so a page cannot carry a novel', () => {
  const root = { dataset: {} };
  const ctx = sandbox(slice(['var log', 'note']), { document: { documentElement: root } });
  for (let i = 0; i < 20; i++) ctx.note('reject', 'x'.repeat(80));
  assert.ok(root.dataset.omarchyConsent.length <= 1000,
    'the attribute stays bounded: ' + root.dataset.omarchyConsent.length);
});

test('the shipped IIFE leaves an app drawer and a privacy dialog alone', () => {
  const { doc } = boot({
    build(d) {
      const drawer = d.createElement('div');
      drawer.className = 'fixed inset-y-0 right-0 bg-background';
      drawer.__computed = { position: 'fixed', zIndex: '120' };
      drawer.innerText = 'Create DNS Record Type Name Value Cancel Create Record';
      const close = d.createElement('button');
      close.setAttribute('aria-label', 'Close');
      drawer.appendChild(close);
      const input = d.createElement('input');
      drawer.appendChild(input);
      d.body.appendChild(drawer);

      const privacy = d.createElement('div');
      privacy.className = 'privacy-dialog';
      privacy.__computed = { position: 'fixed', zIndex: '9999' };
      privacy._rect = { width: 1280, height: 800 };
      privacy.innerText = 'Privacy settings — choose what this app may store.';
      const toggle = d.createElement('input');
      privacy.appendChild(toggle);
      d.body.appendChild(privacy);
    },
  });
  assert.strictEqual(doc.querySelectorAll('.fixed').length, 1, 'the drawer must stay on the page');
  assert.strictEqual(doc.querySelectorAll('.privacy-dialog').length, 1,
    'a privacy-settings dialog full of inputs must stay on the page');
});

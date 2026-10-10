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
  const ctx = sandbox(slice(['isVisible']), {
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
  const bad = sandbox(slice(['isVisible']), {
    document: doc,
    window: { getComputedStyle: () => { throw new Error('boom'); } },
  });
  assert.strictEqual(bad.isVisible(box(10, 10)), false);
});

// ── findButton(): the 60-char cap, the past-the-end read, equal scores ──────
test('findButton keeps a 60-char label, never reads past the list, and keeps the first winner', () => {
  const ctx = sandbox(slice(['var BUTTONS', 'label', 'isVisible', 'findButton']), {
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
  const ctx = sandbox(slice(['genericOverlaySweep']), {
    document: { body: { children: [ov] } },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    CONSENT_WORDS, isVisible: () => true, decideConsent: () => 'reject', unlockScroll: () => {},
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
  const ctx = sandbox(slice(['genericOverlaySweep']), {
    document: { body: { children: [ov] } },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    CONSENT_WORDS, isVisible: () => true, decideConsent: () => 'reject', unlockScroll: () => {},
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
  const ctx = sandbox(slice(['removeAdblockWalls']), {
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
  const ctx = sandbox(slice(['barSweep']), {
    document: {
      querySelectorAll: (sel) => (sel === BUTTONS ? [btn] : []),
      body: { children: [] },
    },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    BUTTONS, label: (e) => (e.innerText || '').trim(), isVisible: () => true,
    REJECT_PATTERNS: [/reject/i], ACCEPT_PATTERNS: [/accept/i],
    CONSENT_WORDS, decideConsent: () => 'accept', unlockScroll: () => {},
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
  const ctx = sandbox(slice(['barSweep']), {
    document: {
      querySelectorAll: () => [],
      body: { children: [strip] },
    },
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (e) => e.__computed },
    BUTTONS, label: (e) => (e.innerText || '').trim(), isVisible: () => true,
    REJECT_PATTERNS: [/reject/i], ACCEPT_PATTERNS: [/accept/i],
    CONSENT_WORDS, decideConsent: () => null, unlockScroll: () => {},
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
    this.ownerDocument = doc || null;
  }
  get className() { return this._class; }
  set className(v) {
    this._class = v || '';
    this.classList = new ClassList();
    String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
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

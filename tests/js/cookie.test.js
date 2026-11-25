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
    querySelector: (sel) => (opts.querySelector ? opts.querySelector(sel) : null),
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
  const ctx = sandbox(slice(['styleOf', 'isVisible']));
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
  const ctx = sandbox(slice(['styleOf', 'var BUTTONS', 'label', 'isVisible', 'findButton']));
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
  const ctx = sandbox(slice(['styleOf', 'var BUTTONS', 'var REJECT_PATTERNS', 'var ACCEPT_PATTERNS',
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

// ── knownWall(): a consent wall that is a page of its own ───────────────────
test('knownWall consents on golem\'s wall page, once, and nowhere else', () => {
  // Regression pinned: golem.de redirects to /sonstiges/zustimmung/auswahl.html and
  // does not come back on its own — the wall IS the page, so the sweep finds nothing to
  // remove and every visit ends there. Three measurements shape the rule: its control
  // cannot be clicked from a userscript (the handler is a page-world onclick that does
  // not fire across worlds), the consent is a cookie whose value carries a version the
  // page's own config supplies (asynchronously — an unversioned write is rejected), and
  // reloading the wall with the cookie in place does not redirect. So the rule writes
  // what its control would have stored and then goes where the wall would have sent us.
  const code = slice(['styleOf', 'isVisible', 'var KNOWN_WALLS', 'var wallBusy', 'knownWall']);
  const WALL = 'https://www.golem.de/sonstiges/zustimmung/auswahl.html';
  const CONFIG = { config: { cookieName: 'golem_consent20', cookieVersion: '|261101' } };

  const build = (opts = {}) => {
    const calls = { cookies: [], replace: [], notes: [], keys: [], queries: 0 };
    const store = opts.store || {};
    const doc = {
      documentElement: fakeEl(),
      body: fakeEl({ tagName: 'BODY' }),
      querySelector: () => { calls.queries += 1; return null; },
    };
    Object.defineProperty(doc, 'cookie', {
      get: () => '',
      set: (v) => { if (opts.cookieThrows) throw new Error('cookies are off'); calls.cookies.push(v); },
    });
    const where = Object.assign({
      hostname: 'www.golem.de',
      pathname: '/sonstiges/zustimmung/auswahl.html',
      search: '',
      href: WALL,
      replace: (u) => { if (opts.replaceThrows) throw new Error('navigation refused'); calls.replace.push(u); },
    }, opts.where || {});
    const ctx = sandbox(code, {
      document: doc,
      location: where,
      sessionStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { calls.keys.push(k); store[k] = v; },
      },
      URLSearchParams,
      Date: opts.now === undefined ? Date : { now: () => opts.now },
      note: (action, detail) => { calls.notes.push([action, detail]); },
      GolemConsent: 'GolemConsent' in opts ? opts.GolemConsent : CONFIG,
    });
    return { ctx, calls, store };
  };

  // the wall, reached from an article: write golem's own consent, then go to the article
  const wall = build({ now: 1795449062123,
                       where: { search: '?from=https%3A%2F%2Fwww.golem.de%2Fnews%2Fki-2611-175000.html' } });
  assert.strictEqual(wall.ctx.knownWall(), 'accept');
  assert.deepStrictEqual(wall.calls.cookies, [
    'golem_consent20=simple|261101; path=/; domain=golem.de; secure; max-age=7776000',
    'golem_c20date=1795449062; path=/; domain=golem.de; secure; max-age=7776000',
  ], 'exactly what setconsentcookie.php stores, both cookies, ninety days');
  assert.deepStrictEqual(wall.calls.replace, ['https://www.golem.de/news/ki-2611-175000.html'],
    'the wall does not redirect itself, so the from= it was reached with is the destination');
  assert.deepStrictEqual(wall.calls.notes, [['accept', 'consent wall www.golem.de']]);
  assert.deepStrictEqual(wall.calls.keys, ['omarchy-wall:www.golem.de']);
  assert.strictEqual(wall.store['omarchy-wall:www.golem.de'], '1795449062123',
    'the attempt is stamped so a failed consent cannot loop');

  // a second sweep on the same page must not fire again
  assert.strictEqual(wall.ctx.knownWall(), null);
  assert.strictEqual(wall.calls.cookies.length, 2);
  assert.strictEqual(wall.calls.replace.length, 1);

  // the guard is a minute, not a minute-and-a-bit: 60000 ms is already stale
  const atMinute = build({ now: 1795449122123, store: { 'omarchy-wall:www.golem.de': '1795449062123' } });
  assert.strictEqual(atMinute.ctx.knownWall(), 'accept', 'a full minute later it may try again');
  const insideMinute = build({ now: 1795449122122, store: { 'omarchy-wall:www.golem.de': '1795449062123' } });
  assert.strictEqual(insideMinute.ctx.knownWall(), null, 'one millisecond short is still the same attempt');

  // the page's config arrives asynchronously: without the version nothing is written
  const early = build({ GolemConsent: null });
  assert.strictEqual(early.ctx.knownWall(), null, 'no consent before the version is known');
  assert.strictEqual(early.calls.cookies.length, 0);
  assert.strictEqual(early.calls.replace.length, 0);
  assert.deepStrictEqual(early.calls.keys, [], 'and no attempt is spent, so a later sweep still acts');
  early.ctx.GolemConsent = CONFIG;
  assert.strictEqual(early.ctx.knownWall(), 'accept', 'the retry must still act');

  // only a plain object's config is trusted (a function carrying one is not the holder)
  const fnHolder = build({ GolemConsent: Object.assign(function () {}, CONFIG) });
  assert.strictEqual(fnHolder.ctx.knownWall(), null, 'typeof object is what makes it the config holder');
  assert.strictEqual(fnHolder.calls.cookies.length, 0);

  // writing the cookie can fail (cookies off): that is not a consent
  const noCookies = build({ cookieThrows: true });
  assert.strictEqual(noCookies.ctx.knownWall(), null);
  assert.strictEqual(noCookies.calls.replace.length, 0, 'nothing may be navigated to when nothing was stored');

  // a navigation that is refused is not a consent either
  const noNav = build({ replaceThrows: true });
  assert.strictEqual(noNav.ctx.knownWall(), null);
  assert.strictEqual(noNav.calls.keys.length, 0, 'a failed navigation must not burn the attempt');

  // a from= that is not golem's own is not followed
  const foreign = build({ where: { search: '?from=https%3A%2F%2Fevil.example%2F' } });
  assert.strictEqual(foreign.ctx.knownWall(), 'accept');
  assert.deepStrictEqual(foreign.calls.replace, ['https://www.golem.de/'],
    'an off-site from= must fall back to the front page');

  // nowhere else: an article page and another host must not be consented to
  for (const where of [
    { hostname: 'www.golem.de', pathname: '/news/x-2611-175000.html', search: '', href: 'https://www.golem.de/news/x.html' },
    { hostname: 'example.org', pathname: '/sonstiges/zustimmung/auswahl.html', search: '', href: 'https://example.org/x' },
  ]) {
    const other = build({ where });
    assert.strictEqual(other.ctx.knownWall(), null,
      'nothing may be consented to on ' + where.hostname + where.pathname);
    assert.strictEqual(other.calls.cookies.length, 0);
    assert.strictEqual(other.calls.replace.length, 0);
    assert.strictEqual(other.calls.queries, 0, 'a wall declares its strategy; there is no DOM to poke');
  }
});

test('the sweep and the mutation handler both run the known-wall rule', () => {
  assert.match(SOURCE, /function sweep\(\) \{\n    knownWall\(\);/,
    'sweep() must try the known-wall rule before it removes anything');
  assert.match(SOURCE, /function mutationSweep\(\) \{\n    try \{\n      knownWall\(\);/,
    'late-rendered walls are only caught by the mutation handler');
  // …and every mutation-driven pass goes through the coalescer, so a SPA that mutates
  // continuously cannot turn five whole-document scans into an idle-loop.
  assert.match(SOURCE, /function onMutation\(\) \{\n(?:.|\n)*?settleTimer = setTimeout/,
    'onMutation must queue a trailing pass instead of sweeping per delta');
});

// ── bannerFor(): find / don't run away when the node is the body ────────────
test('bannerFor returns the pinned ancestor holding the button', () => {
  const ctx = sandbox(slice(['styleOf', 'bannerFor']));
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

// ── looksLikeConsent(): a pinned box with a Close button is not a banner ────
// Regression: Appwrite Console's "Create DNS record" drawer has an X whose aria-label
// is "Close", and the reject pattern matches that. deepConsentSweep scans the whole
// document, found the X, treated the drawer's own fixed panel as the consent banner,
// clicked the X and removed the panel 800 ms later — the drawer opened and vanished
// within a second.
test('looksLikeConsent rejects a form drawer and any box that does not read like consent', () => {
  const ctx = sandbox(slice(['var CONSENT_WORDS', 'looksLikeConsent']));
  const form = (yes) => (sel) => (/input|select|textarea|form/.test(sel) && yes ? fakeEl({ tagName: 'INPUT' }) : null);

  // the drawer: pinned, has an X, holds inputs — never a banner
  assert.strictEqual(ctx.looksLikeConsent(fakeEl({
    text: 'Create DNS Record Type Name Value Cancel Create Record',
    querySelector: form(true),
  })), false);
  // even a settings dialog that does talk about cookies is a form, not a banner
  assert.strictEqual(ctx.looksLikeConsent(fakeEl({
    text: 'Cookie settings for this workspace',
    querySelector: form(true),
  })), false);
  // no form, no consent wording: still not a banner
  assert.strictEqual(ctx.looksLikeConsent(fakeEl({ text: 'Create DNS Record Type Name' })), false);
  // the real thing
  assert.strictEqual(ctx.looksLikeConsent(fakeEl({
    text: 'We use cookies and similar technologies.',
    querySelector: form(false),
  })), true);
  assert.strictEqual(ctx.looksLikeConsent(null), false, 'nothing to look at is not consent');
});

test('looksLikeConsent bounds the text it reads', () => {
  const ctx = sandbox(slice(['var CONSENT_WORDS', 'looksLikeConsent']));
  const banner = (text) => fakeEl({ text });
  assert.strictEqual(ctx.looksLikeConsent(banner('cookies!!')), false, '9 characters is too short to judge');
  assert.strictEqual(ctx.looksLikeConsent(banner('cookies!!!')), true, '10 characters is enough');
  assert.strictEqual(ctx.looksLikeConsent(banner('cookie ' + 'x'.repeat(1993))), true, '2000 characters is still a banner');
  assert.strictEqual(ctx.looksLikeConsent(banner('cookie ' + 'x'.repeat(1994))), false, 'past 2000 characters it is page text');
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
  const ctx = sandbox(slice(['styleOf', 'var UNLOCK_CLASSES', 'unlockScroll']), {
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

// The sweep and whole-IIFE harness (the shipped entry point, not a sliced copy) now
// lives in a sibling file mirroring tests/js/adblock.test.js, which likewise carries
// both the sliced-logic tests and a whole-IIFE vm harness. Requiring it here keeps
// every target that runs this one file covering the shipped IIFE too.
require('./cookie.harness.test.js');

// ── the authentication-page guard ────────────────────────────────────────────
// Observed in the wild: Gmail sign-in broke with this script installed. It matches every
// page, and a sign-in screen is full of buttons it would click ("I agree", "Not now").
function consentLogFor(hostname, pathname, overrides = {}) {
  const noop = () => {};
  const el = () => ({ style: {}, setAttribute: noop, appendChild: noop, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, click: noop, remove: noop,
    querySelector: () => null, querySelectorAll: () => [], matches: () => false,
    classList: { add: noop, remove: noop, contains: () => false } });
  const document = Object.assign({
    readyState: 'complete', documentElement: el(), body: el(), head: el(),
    createElement: el, createTextNode: () => ({}), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
    removeEventListener: noop, dispatchEvent: () => true,
  }, overrides.document || {});
  const win = Object.assign({
    document,
    location: { hostname, pathname, href: `https://${hostname}${pathname}`, protocol: 'https:' },
    navigator: { userAgent: 'test', languages: [] },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: noop, removeEventListener: noop, open: noop, scrollTo: noop,
  }, overrides.window || {});
  win.window = win; win.self = win; win.top = win; win.parent = win;
  document.defaultView = win;      // styleOf() reaches the style through the real window
  const vm = require('node:vm');
  const ctx = vm.createContext(win);
  ctx.MutationObserver = win.MutationObserver;
  vm.runInContext(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'userscripts', 'cookie-banner-remover.js'), 'utf8'), ctx);
  return win.__omarchyConsent || [];
}

test('it leaves Google sign-in pages completely alone', () => {
  const log = consentLogFor('accounts.google.com', '/signin/v2/challenge/pwd');
  assert.ok(log.some((e) => e.action === 'skip'), 'an auth page is skipped: ' + JSON.stringify(log));
  assert.ok(!log.some((e) => e.action === 'reject' || e.action === 'accept'),
    'nothing is clicked: ' + JSON.stringify(log));
});

test('it leaves a /login path alone on any host', () => {
  const log = consentLogFor('example.com', '/login');
  assert.ok(log.some((e) => e.action === 'skip'), JSON.stringify(log));
});

test('it still acts on an ordinary page', () => {
  const log = consentLogFor('example.com', '/article');
  assert.ok(!log.some((e) => e.action === 'skip'),
    'a normal page must not be skipped: ' + JSON.stringify(log));
});

// ── a labelled close button is not consent ───────────────────────────────────
// In the wild: Appwrite Console. "Create DNS record" opens a fixed right-hand drawer
// whose X carries aria-label "Close" — which the reject pattern matches. The sweep took
// the drawer panel itself as the banner, clicked the X and removed the panel after
// 800 ms, so the drawer appeared and vanished within a second.
test('it leaves a form drawer with a labelled close button alone', () => {
  const input = fakeEl({ tagName: 'INPUT' });
  const drawer = fakeEl({
    tagName: 'DIV', className: 'bg-background fixed inset-y-0 right-0', position: 'fixed',
    width: 500, height: 900, z: 120,
    text: 'Create DNS Record Type Name Value Cancel Create Record',
    querySelector: (sel) => (/input|select|textarea|form/.test(sel) ? input : null),
  });
  const close = fakeEl({ tagName: 'BUTTON', aria: 'Close', width: 32, height: 32, parentElement: drawer });
  const create = fakeEl({ tagName: 'BUTTON', text: 'Create Record', width: 120, height: 36, parentElement: drawer });
  drawer.querySelectorAll = () => [close, create];

  const log = consentLogFor('appwrite.io', '/organizations/1/domains/2', {
    document: {
      body: fakeEl({ tagName: 'BODY', children: [drawer] }),
      querySelectorAll: (sel) => (/button|\[role="button"\]/.test(sel) ? [close, create] : []),
    },
    window: { getComputedStyle: (el) => makeWindow().getComputedStyle(el) },
  });

  assert.ok(!log.some((e) => e.action === 'reject' || e.action === 'accept'),
    'the drawer\'s X must not be clicked: ' + JSON.stringify(log));
  assert.ok(!drawer.removedFromDom, 'the drawer must stay on the page: ' + JSON.stringify(log));
});

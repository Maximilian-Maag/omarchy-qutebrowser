// Unit tests for userscripts/youtube-adblock.js — the pure parts.
//
// The script is an IIFE, so its functions are not importable. They are sliced out of
// the shipped source (cutting at the next 2-space declaration, which is where the
// script separates its top-level pieces) and evaluated in a sandbox. That tests the
// code that actually runs, with no npm dependencies.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'userscripts', 'youtube-adblock.js'), 'utf8');

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
  const ctx = { console, location: { search: '', pathname: '' }, document: {}, window: {}, ...extra };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

test('ad params are stripped from the outgoing player request', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripRequestAds', 'stripAds', 'walkAds', 'patchJson']));
  const body = JSON.stringify({
    videoId: 'dQw4w9WgXcQ',
    context: { client: { clientName: 'WEB' } },
    adSlots: [{ slot: 1 }],
    playerRequest: { adParams: { key: 'x' } },
    streamingData: { nested: { adPlacements: [{ p: 1 }], formats: [{ itag: 18 }] } },
  });
  const out = JSON.parse(ctx.stripRequestAds(body));
  assert.strictEqual(out.videoId, 'dQw4w9WgXcQ');
  assert.deepStrictEqual(out.context, { client: { clientName: 'WEB' } });
  assert.strictEqual(out.adSlots, undefined);
  assert.strictEqual(out.playerRequest.adParams, undefined);
  // the deep sweep is the regression this pins: a hand-listed path missed nested ads
  assert.strictEqual(out.streamingData.nested.adPlacements, undefined);
  assert.deepStrictEqual(out.streamingData.nested.formats, [{ itag: 18 }]);
});

test('a request with no ad fields is returned unchanged', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripRequestAds', 'stripAds', 'walkAds', 'patchJson']));
  const body = JSON.stringify({ videoId: 'abc', context: {} });
  assert.deepStrictEqual(JSON.parse(ctx.stripRequestAds(body)), { videoId: 'abc', context: {} });
});

test('ad URLs are recognised, video streams are not', () => {
  const ctx = sandbox(slice(['var AD_URLS', 'isAdUrl']));
  assert.strictEqual(ctx.isAdUrl('https://www.youtube.com/pagead/id'), true);
  assert.strictEqual(ctx.isAdUrl('https://googleads.g.doubleclick.net/x'), true);
  assert.strictEqual(ctx.isAdUrl('https://rr3---sn-abc.googlevideo.com/videoplayback?x=1'), false);
  assert.strictEqual(ctx.isAdUrl('https://www.youtube.com/api/stats/watchtime'), false);
  assert.strictEqual(ctx.isAdUrl(null), false);
});

test('the video id is read from watch and shorts URLs', () => {
  const ctx = sandbox(slice(['sbVideoId']), { location: { search: '?v=dQw4w9WgXcQ&t=1', pathname: '/watch' } });
  assert.strictEqual(ctx.sbVideoId(), 'dQw4w9WgXcQ');
  const shorts = sandbox(slice(['sbVideoId']), { location: { search: '', pathname: '/shorts/abcdef12345' } });
  assert.strictEqual(shorts.sbVideoId(), 'abcdef12345');
  const none = sandbox(slice(['sbVideoId']), { location: { search: '', pathname: '/' } });
  assert.strictEqual(none.sbVideoId(), null);
});

test('segment lookup respects the end guard that stops a skip loop', () => {
  const ctx = sandbox(slice(['sbVideoId', 'sbSegmentAt']));
  ctx.SB = { segments: [{ start: 10, end: 70, category: 'sponsor' }, { start: 100, end: 110, category: 'intro' }] };
  assert.strictEqual(ctx.sbSegmentAt(10).category, 'sponsor');
  assert.strictEqual(ctx.sbSegmentAt(30).category, 'sponsor');
  assert.strictEqual(ctx.sbSegmentAt(69.8).category, 'sponsor');
  // just past the guarded end: not "inside", or the watcher would seek forever
  assert.strictEqual(ctx.sbSegmentAt(69.9), null);
  assert.strictEqual(ctx.sbSegmentAt(70), null);
  assert.strictEqual(ctx.sbSegmentAt(9.9), null);
  assert.strictEqual(ctx.sbSegmentAt(0), null);
});

test('stripRequestAds rejects non-string input and anything that is not JSON', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripRequestAds', 'stripAds', 'walkAds', 'patchJson']));
  // The guard short-circuits on a non-string (`||` must not become `&&`), and a
  // one-character payload is never JSON.
  assert.strictEqual(ctx.stripRequestAds(null), null);
  assert.strictEqual(ctx.stripRequestAds(12345), null);
  assert.strictEqual(ctx.stripRequestAds('x'), null);
  // A JSON *number* is parseable but is not a request body: the head check must
  // reject it rather than ship it back as "1234567".
  assert.strictEqual(ctx.stripRequestAds('1234567'), null);
  // The smallest real payload is two characters and must still be handled.
  assert.strictEqual(ctx.stripRequestAds('{}'), '{}');
  assert.ok(!ctx.stripRequestAds('{"adSlots":[1],"x":2}').includes('adSlots'));
});

test('the ad sweep reaches exactly the depth limit, in objects and arrays', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripRequestAds', 'stripAds', 'walkAds', 'patchJson']));
  const nest = (levels, leaf) => { let n = leaf; for (let i = 0; i < levels; i++) n = { child: n }; return n; };
  const nestArr = (levels, leaf) => { let n = leaf; for (let i = 0; i < levels; i++) n = [n]; return n; };
  const drillObj = (root, levels) => { let n = root; for (let i = 0; i < levels; i++) n = n.child; return n; };
  const drillArr = (root, levels) => { let n = root; for (let i = 0; i < levels; i++) n = n[0]; return n; };

  // A field at the depth limit (12) is stripped...
  const at12 = nest(12, { adPlacements: [1], keep: true });
  ctx.stripAds(at12);
  assert.strictEqual(drillObj(at12, 12).adPlacements, undefined, 'level-12 ad must be removed');
  assert.strictEqual(drillObj(at12, 12).keep, true);
  // ...and one *past* it is left alone, so the bound is a real bound and not a
  // one-off that walks to the end of the document.
  const at13 = nest(13, { adPlacements: [1] });
  ctx.stripAds(at13);
  assert.deepStrictEqual(drillObj(at13, 13).adPlacements, [1], 'level-13 ad must survive the bound');
  // The array branch increments depth too (the same limit applies).
  const arr13 = nestArr(13, { adPlacements: [1] });
  ctx.stripAds(arr13);
  assert.deepStrictEqual(drillArr(arr13, 13).adPlacements, [1], 'arrays must count toward the depth bound');
});

test('patchJson keeps the type it was given and strips on the way through', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripRequestAds', 'stripAds', 'walkAds', 'patchJson']));
  const text = JSON.stringify({ adSlots: [1], ok: true });
  const out = ctx.patchJson(text);
  // string in -> a JSON *object* string out (not the original text, not a re-quoted string)
  assert.strictEqual(typeof out, 'string');
  assert.deepStrictEqual(JSON.parse(out), { ok: true });
  // a non-string payload comes back as the same object, mutated in place
  const obj = { adPlacements: [1], ok: true };
  assert.strictEqual(ctx.patchJson(obj), obj);
  assert.strictEqual(obj.adPlacements, undefined);
});

test('sbFetch asks the SponsorBlock API for the right video and categories', () => {
  const seen = {};
  const ctx = sandbox(slice(['sbFetch']), {
    SB_API: 'https://sponsor.ajay.app/api/skipSegments',
    SB_CATEGORIES: ['sponsor', 'intro'],
    SB: { enabled: true, segments: [], fetchedFor: null, fullWarnedFor: false },
    sbToast: () => {},
    encodeURIComponent,
    fetch: (url) => { seen.url = url; return Promise.resolve({ ok: false, json: () => Promise.resolve([]) }); },
  });
  ctx.sbFetch('dQw4w9WgXcQ');
  assert.strictEqual(typeof seen.url, 'string', 'the URL must be built by concatenation, not arithmetic');
  assert.ok(seen.url.startsWith('https://sponsor.ajay.app/api/skipSegments?videoID=dQw4w9WgXcQ&categories='),
    seen.url);
  assert.ok(seen.url.includes(encodeURIComponent(JSON.stringify(['sponsor', 'intro']))), seen.url);
});

test('adShowing, clickSkip and removeAdElements report honestly', () => {
  const code = slice(['var AD_DOM', 'removeAdElements', 'adShowing', 'clickSkip']);
  // A throwing DOM must not read as "an ad is showing" (the catch returns false).
  const throwing = sandbox(code, { document: {} });
  assert.strictEqual(throwing.adShowing({}), false);
  const quiet = sandbox(code, { document: { querySelector: () => null } });
  // getAdState() === 0 is not an ad; only a positive state is.
  assert.strictEqual(quiet.adShowing({ classList: { contains: () => false }, getAdState: () => 0 }), false);
  assert.strictEqual(quiet.adShowing({ classList: { contains: () => true } }), true);
  // No skip button on the page -> nothing clicked.
  assert.strictEqual(quiet.clickSkip(), false);

  // removeAdElements walks exactly the elements the list reports.
  const removed = [];
  let readPastEnd = false;
  const els = { length: 2, 0: { remove: () => removed.push(0) }, 1: { remove: () => removed.push(1) } };
  Object.defineProperty(els, '2', { configurable: true, get() { readPastEnd = true; return undefined; } });
  const ctx = sandbox(code, { document: { querySelectorAll: () => els, querySelector: () => null } });
  ctx.removeAdElements();
  assert.deepStrictEqual(removed, [0, 1]);
  assert.strictEqual(readPastEnd, false, 'must not read the slot one past the end');
});

test('forceEnd ends a live ad but leaves a zero-length video alone', () => {
  const ctx = sandbox(slice(['var adWasOn', 'var savedRate', 'forceEnd', 'restore']));
  const zero = { duration: 0, currentTime: -1, playbackRate: 1 };
  ctx.forceEnd(zero);
  assert.strictEqual(zero.currentTime, -1, 'a d == 0 guard must not seek');
  const ad = { duration: 30, currentTime: 2, playbackRate: 1 };
  ctx.forceEnd(ad);
  assert.strictEqual(ad.currentTime, 30);
  assert.ok(ad.playbackRate >= 16);
  ctx.restore(ad);
  assert.strictEqual(ad.playbackRate, 1, 'the viewer speed is put back');
});

test('tick puts the viewer speed back only after an ad actually played', () => {
  const ctx = sandbox(
    slice(['var AD_DOM', 'removeAdElements', 'adShowing', 'clickSkip', 'var adWasOn',
           'var savedRate', 'forceEnd', 'restore', 'tick']),
    { sbEnsurePolling: () => {} });
  const video = { duration: 30, currentTime: 2, playbackRate: 1 };
  const player = { classList: { contains: () => false } };
  ctx.document = {
    querySelector: (sel) => (sel.includes('movie_player') ? player
      : sel.includes('video') ? video : null),
  };
  ctx.forceEnd(video);                       // remembers the speed and blasts through
  assert.strictEqual(video.playbackRate, 16);
  ctx.tick();                                // no ad on screen now -> nothing to restore
  assert.strictEqual(video.playbackRate, 16,
    'a fresh page load (no ad was on) must not reset the speed');
});

// ── the whole IIFE, driven through a fake player/DOM ──────────────────────
// The setup blocks (window property setters, fetch/XHR interception, the timers)
// are not declarations the slicer can pull out, so here the entire shipped file
// runs in a vm with just enough of a browser: no npm, no jsdom.
function makeResponse(body, opts = {}) {
  const status = opts.status === undefined ? 200 : opts.status;
  return {
    body,
    status,
    statusText: opts.statusText || '',
    headers: opts.headers || {},
    ok: status >= 200 && status < 300,
    clone() { return makeResponse(this.body, { status: this.status, statusText: this.statusText, headers: this.headers }); },
    text() { return Promise.resolve(this.body); },
    json() { return Promise.resolve(JSON.parse(this.body)); },
  };
}

function boot(over = {}) {
  const log = { fetch: [], intervals: [], cleared: [], timeouts: [] };
  let now = 0;
  let nextBody = '{}';
  const realFetch = (input, init) => {
    log.fetch.push({ input, init });
    return Promise.resolve(makeResponse(nextBody));
  };
  const document = {
    readyState: 'complete',
    documentElement: { appendChild() {} },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, textContent: '', remove() {} }; },
  };
  class FakeXHR {
    constructor() { this.readyState = 0; this.responseType = ''; this._responseText = ''; this._listeners = {}; this.__yt_url = null; }
    open(method, url) { this.method = method; this.openedUrl = url; }
    send(body) { this.sentBody = body; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    get responseText() { return this._responseText; }
    set responseText(v) { this._responseText = v; }
    fire(type) { (this._listeners[type] || []).forEach((fn) => fn.call(this)); }
  }
  const ctx = {
    console,
    window: {},
    document,
    location: { search: '', pathname: '/' },
    XMLHttpRequest: FakeXHR,
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} },
    Response: function (body, opts) { return makeResponse(body, opts); },
    Date: { now: () => now },
    setInterval: (cb, ms) => { const id = log.intervals.length + 1; log.intervals.push({ id, cb, ms }); return id; },
    clearInterval: (id) => { log.cleared.push(id); },
    setTimeout: (cb, ms) => { const id = log.timeouts.length + 1; log.timeouts.push({ id, cb, ms }); return id; },
    ...over,
  };
  ctx.window.fetch = realFetch;
  ctx.window.PointerEvent = function () {};
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return {
    ctx, log,
    setNow: (v) => { now = v; },
    setNextBody: (b) => { nextBody = b; },
  };
}

test('the ytInitial* globals are installed as configurable, enumerable setters', () => {
  const { ctx } = boot();
  for (const name of ['ytInitialPlayerResponse', 'ytInitialData']) {
    const d = Object.getOwnPropertyDescriptor(ctx.window, name);
    assert.ok(d, `${name} must be defined on window`);
    assert.strictEqual(d.configurable, true, `${name} must be configurable`);
    assert.strictEqual(d.enumerable, true, `${name} must be enumerable`);
    assert.strictEqual(typeof d.set, 'function');
  }
  ctx.window.ytInitialData = { adPlacements: [1], ok: 1 };
  assert.deepStrictEqual(ctx.window.ytInitialData, { ok: 1 }, 'the setter must strip ads');
});

test('fetch blocks ad URLs and never lets them reach the network', async () => {
  const { ctx, log } = boot();
  const blocked = await ctx.window.fetch('https://googleads.g.doubleclick.net/pagead/id');
  assert.strictEqual(await blocked.text(), '{}');
  assert.strictEqual(log.fetch.length, 0, 'a string ad URL must be blocked');
  // a Request-like object (not a string) must be recognised too
  const blockedObj = await ctx.window.fetch({ url: 'https://ad.doubleclick.net/x' });
  assert.strictEqual(await blockedObj.text(), '{}');
  assert.strictEqual(log.fetch.length, 0, 'an object-form ad URL must be blocked');
});

test('fetch strips ad params from player requests only, and survives a missing init', async () => {
  const { ctx, log } = boot();
  const body = JSON.stringify({ adSlots: [1], videoId: 'x' });
  await ctx.window.fetch('https://www.youtube.com/youtubei/v1/player?key=1', { method: 'POST', body });
  assert.strictEqual(log.fetch.length, 1);
  assert.strictEqual(JSON.parse(log.fetch[0].init.body).adSlots, undefined,
    'the outgoing player request must have its ad params stripped');
  assert.strictEqual(JSON.parse(log.fetch[0].init.body).videoId, 'x');
  // a NON-player endpoint must be left untouched
  await ctx.window.fetch('https://www.youtube.com/api/stats/watchtime', { body });
  assert.strictEqual(log.fetch[1].init.body, body, 'non-player bodies must not be rewritten');
  // a player URL with no init at all must not throw
  await ctx.window.fetch('https://www.youtube.com/youtubei/v1/player?key=1');
  assert.strictEqual(log.fetch.length, 3);
});

test('XHR responses are stripped at readystatechange and the patch stays configurable', () => {
  const { ctx } = boot();
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('POST', 'https://www.youtube.com/youtubei/v1/player?key=1');
  xhr.send(JSON.stringify({ adSlots: [1], videoId: 'x' }));
  assert.strictEqual(JSON.parse(xhr.sentBody).adSlots, undefined, 'request ads are stripped');
  xhr.readyState = 4;
  xhr.responseType = '';
  xhr._responseText = JSON.stringify({ adSlots: [1], streamingData: { ok: 1 } });
  xhr.fire('readystatechange');
  assert.strictEqual(JSON.parse(xhr.responseText).adSlots, undefined,
    'the response must be stripped before the site reads it');
  const d = Object.getOwnPropertyDescriptor(xhr, 'responseText');
  assert.ok(d && d.get, 'responseText is redefined as a getter');
  assert.strictEqual(d.configurable, true, 'the patch property must stay configurable');
});

test('the eager poll stops at its deadline, not one tick late', () => {
  const handle = boot();
  const eager = handle.log.intervals.find((i) => i.ms === 250);
  assert.ok(eager, 'the eager poll interval must be armed');
  handle.setNow(90000);              // exactly the deadline (armed at 0 + 90 s)
  eager.cb();
  assert.ok(!handle.log.cleared.includes(eager.id),
    'Date.now() === deadline is not past it: the poll keeps running');
  handle.setNow(90001);
  eager.cb();
  assert.ok(handle.log.cleared.includes(eager.id), 'past the deadline the poll is cleared');
});

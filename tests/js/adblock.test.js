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

test('the deep sweep removes nested ad fields at any depth and counts them', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripAds', 'walkAds']));
  const payload = {
    videoId: 'dQw4w9WgXcQ',
    context: { client: { clientName: 'WEB' } },
    adSlots: [{ slot: 1 }],
    playerRequest: { adParams: { key: 'x' } },
    streamingData: { nested: { adPlacements: [{ p: 1 }], formats: [{ itag: 18 }] } },
  };
  const hits = ctx.stripAds(payload);
  assert.strictEqual(hits, 3, 'adSlots, adParams and the nested adPlacements');
  assert.strictEqual(payload.videoId, 'dQw4w9WgXcQ');
  assert.deepStrictEqual(payload.context, { client: { clientName: 'WEB' } });
  assert.strictEqual(payload.adSlots, undefined);
  assert.strictEqual(payload.playerRequest.adParams, undefined);
  // the deep sweep is the regression this pins: a hand-listed path missed nested ads
  assert.strictEqual(payload.streamingData.nested.adPlacements, undefined);
  assert.deepStrictEqual(payload.streamingData.nested.formats, [{ itag: 18 }]);
});

test('a payload with no ad fields reports zero hits, so callers can skip the copy', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripAds', 'walkAds']));
  const clean = { videoId: 'abc', context: {}, streamingData: { formats: [{ itag: 18 }] } };
  assert.strictEqual(ctx.stripAds(clean), 0);
  assert.deepStrictEqual(clean, { videoId: 'abc', context: {}, streamingData: { formats: [{ itag: 18 }] } });
  // a non-object is not a payload: no hits, no throw
  assert.strictEqual(ctx.stripAds(null), 0);
  assert.strictEqual(ctx.stripAds('text'), 0);
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

test('pruneFetchResponse drops the stale Content-Length and keeps the rest', async () => {
  function FakeHeaders(init) {
    this.map = {};
    const src = init || {};
    for (const k of Object.keys(src)) this.map[k.toLowerCase()] = String(src[k]);
  }
  FakeHeaders.prototype.get = function (k) {
    const v = this.map[String(k).toLowerCase()];
    return v === undefined ? null : v;
  };
  FakeHeaders.prototype.delete = function (k) { delete this.map[String(k).toLowerCase()]; };
  function FakeResponse(body, opts) {
    return {
      body,
      status: (opts && opts.status) || 200,
      statusText: (opts && opts.statusText) || '',
      headers: (opts && opts.headers) || new FakeHeaders(),
      json: () => Promise.resolve(JSON.parse(body)),
    };
  }
  const ctx = sandbox(
    slice(['var AD_FIELDS', 'stripAds', 'walkAds', 'pruneFetchResponse']),
    { Response: FakeResponse, Headers: FakeHeaders });

  const dirty = {
    status: 200, statusText: 'OK',
    headers: { 'content-type': 'application/json', 'content-length': '4096' },
    clone() { return { json: () => Promise.resolve({ adPlacements: [1], streamingData: { ok: 1 } }) }; },
  };
  const out = await ctx.pruneFetchResponse(dirty);
  assert.strictEqual(out.status, 200, 'status is carried over');
  assert.strictEqual(out.statusText, 'OK');
  assert.strictEqual(out.headers.get('content-type'), 'application/json', 'real headers survive');
  // A kept Content-Length is a lie about a shorter body: Chromium then truncates
  // or refuses the read and the player wedges. This is the uBO behaviour too.
  assert.strictEqual(out.headers.get('content-length'), null, 'the stale length is dropped');
  const body = JSON.parse(out.body);
  assert.strictEqual(body.adPlacements, undefined);
  assert.deepStrictEqual(body.streamingData, { ok: 1 });

  // no ad fields -> the very same Response object, not a rebuilt one
  const clean = { status: 200, clone() { return { json: () => Promise.resolve({ videoId: 'x' }) }; } };
  assert.strictEqual(await ctx.pruneFetchResponse(clean), clean);
  // a non-JSON body must not throw; the original response is returned
  const broken = { status: 200, clone() { return { json: () => Promise.reject(new Error('nope')) }; } };
  assert.strictEqual(await ctx.pruneFetchResponse(broken), broken);
});

test('scaleAdTimers compresses only the 17 s ad countdown, once', () => {
  const calls = [];
  const ctx = sandbox(slice(['scaleAdTimers']), {
    window: { setTimeout: (fn, ms) => { calls.push(ms); return 1; } },
  });
  ctx.scaleAdTimers();
  ctx.scaleAdTimers();                      // idempotent: wrapping twice would double-scale
  ctx.window.setTimeout(() => {}, 17000);
  assert.deepStrictEqual(calls, [17], 'the ad countdown is compressed to 17 ms');
  ctx.window.setTimeout(() => {}, 3000);
  ctx.window.setTimeout(() => {}, 20000);
  ctx.window.setTimeout(() => {}, 17001);
  assert.deepStrictEqual(calls, [17, 3000, 20000, 17001],
    'no other delay is touched — 20 s is the "still watching" prompt, not an ad');
});

test('adBlockedUnplayable recognises only the ad-blocked error', () => {
  const ctx = sandbox(slice(['adBlockedUnplayable']));
  const sub = { runs: [{ text: 'WEB_PAGE_TYPE_UNKNOWN' },
                       { text: 'https://support.google.com/youtube/answer/3037019' }] };
  const blocked = { playabilityStatus: {
    status: 'UNPLAYABLE',
    errorScreen: { playerErrorMessageRenderer: { subreason: sub } } } };
  assert.strictEqual(ctx.adBlockedUnplayable(blocked), true);

  // a captcha wall is a different problem: reloading must not be attempted
  const captcha = { playabilityStatus: {
    status: 'UNPLAYABLE',
    errorScreen: { playerCaptchaViewModel: {},
                   playerErrorMessageRenderer: { subreason: sub } } } };
  assert.strictEqual(ctx.adBlockedUnplayable(captcha), false);

  // right subreason text, wrong status
  const ok = { playabilityStatus: { status: 'OK',
    errorScreen: { playerErrorMessageRenderer: { subreason: sub } } } };
  assert.strictEqual(ctx.adBlockedUnplayable(ok), false);
  // only one of the two markers
  const half = { playabilityStatus: { status: 'UNPLAYABLE',
    errorScreen: { playerErrorMessageRenderer: { subreason: { runs: [{ text: 'WEB_PAGE_TYPE_UNKNOWN' }] } } } } };
  assert.strictEqual(ctx.adBlockedUnplayable(half), false);
  assert.strictEqual(ctx.adBlockedUnplayable(null), false);
  assert.strictEqual(ctx.adBlockedUnplayable({}), false);
});

test('repairBlockedVideo reloads once per id and then backs off for 30 s', () => {
  const loads = [];
  const player = {
    getPlayerResponse: () => ({ playabilityStatus: {
      status: 'UNPLAYABLE',
      errorScreen: { playerErrorMessageRenderer: { subreason: { runs: [
        { text: 'WEB_PAGE_TYPE_UNKNOWN' },
        { text: 'https://support.google.com/youtube/answer/3037019' }] } } } },
      videoDetails: { videoId: 'dQw4w9WgXcQ' },
      playerConfig: { playbackStartConfig: { startSeconds: 42 } } }),
    loadVideoById: (id, start) => loads.push([id, start]),
  };
  const ctx = sandbox(
    slice(['adBlockedUnplayable', 'var repair', 'repairBlockedVideo']),
    { document: { querySelector: () => player } });
  assert.strictEqual(ctx.repairBlockedVideo(1000), true);
  assert.deepStrictEqual(loads, [['dQw4w9WgXcQ', 42]], 'reloads at the saved position');
  assert.strictEqual(ctx.repairBlockedVideo(2000), false, 'no second reload inside 30 s');
  assert.strictEqual(loads.length, 1);
  assert.strictEqual(ctx.repairBlockedVideo(31001), true, 'past the window it may try again');
  assert.strictEqual(loads.length, 2);

  // a healthy player is never touched
  const healthy = { getPlayerResponse: () => ({ playabilityStatus: { status: 'OK' } }),
                    loadVideoById: () => { throw new Error('must not reload'); } };
  const clean = sandbox(
    slice(['adBlockedUnplayable', 'var repair', 'repairBlockedVideo']),
    { document: { querySelector: () => healthy } });
  assert.strictEqual(clean.repairBlockedVideo(1000), false);
});

test('the ad sweep reaches exactly the depth limit, in objects and arrays', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripAds', 'walkAds', 'patchJson']));
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

test('repairStalledVideo re-loads a wedged player once and backs off', () => {
  const loads = [];
  const video = { currentTime: 10, duration: 635, readyState: 4 };
  const player = {
    classList: { contains: () => false },
    getPlayerState: () => 1,
    loadVideoById: (id, start) => loads.push([id, start]),
  };
  const ctx = sandbox(
    slice(['adShowing', 'sbVideoId', 'var progress', 'repairStalledVideo']),
    {
      document: { querySelector: (sel) => (sel.indexOf('ad-showing') !== -1 ? null
        : (sel.indexOf('video.html5-main-video') !== -1 ? video : player)) },
      location: { search: '?v=dQw4w9WgXcQ', pathname: '/watch' },
    });
  // healthy: nothing to do
  assert.strictEqual(ctx.repairStalledVideo(1000), false);
  assert.strictEqual(loads.length, 0);

  // the mid-roll detach: duration gone, no media, player reports -1
  video.duration = NaN;
  video.readyState = 0;
  player.getPlayerState = () => -1;
  assert.strictEqual(ctx.repairStalledVideo(2000), false, 'one bad sample is not enough');
  assert.strictEqual(ctx.repairStalledVideo(2100), false);
  assert.strictEqual(ctx.repairStalledVideo(2200), true, 'three bad samples re-load');
  assert.deepStrictEqual(loads, [['dQw4w9WgXcQ', 9]], 'resumes one second before the stall');

  // still broken: the 30 s back-off keeps it from becoming a reload loop
  assert.strictEqual(ctx.repairStalledVideo(2300), false);
  assert.strictEqual(ctx.repairStalledVideo(2400), false);
  assert.strictEqual(ctx.repairStalledVideo(2500), false);
  assert.strictEqual(loads.length, 1);

  // a viewer who pressed pause must never be overruled
  const pausedLoads = [];
  const pausedVideo = { currentTime: 5, duration: 600, readyState: 4 };
  const paused = {
    classList: { contains: () => false }, getPlayerState: () => 2,
    loadVideoById: () => pausedLoads.push(1),
  };
  pausedVideo.duration = NaN;
  pausedVideo.readyState = 0;
  const ctx2 = sandbox(
    slice(['adShowing', 'sbVideoId', 'var progress', 'repairStalledVideo']),
    {
      document: { querySelector: (sel) => (sel.indexOf('ad-showing') !== -1 ? null
        : (sel.indexOf('video.html5-main-video') !== -1 ? pausedVideo : paused)) },
      location: { search: '?v=dQw4w9WgXcQ', pathname: '/watch' },
    });
  ctx2.repairStalledVideo(1000);          // learns the duration
  pausedVideo.duration = NaN;
  pausedVideo.readyState = 0;
  for (let i = 0; i < 6; i++) assert.strictEqual(ctx2.repairStalledVideo(2000 + i * 100), false);
  assert.strictEqual(pausedLoads.length, 0);
});

test('patchJson keeps the type it was given and strips on the way through', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripAds', 'walkAds', 'patchJson']));
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
           'var savedRate', 'forceEnd', 'restore',
           'adBlockedUnplayable', 'var repair', 'repairBlockedVideo', 'sbVideoId', 'var progress', 'repairStalledVideo', 'tick']),
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
class FakeHeaders {
  constructor(init) {
    this.map = {};
    const src = init && init.map ? init.map : (init || {});
    for (const k of Object.keys(src)) this.map[k.toLowerCase()] = String(src[k]);
  }
  get(k) { const v = this.map[String(k).toLowerCase()]; return v === undefined ? null : v; }
  delete(k) { delete this.map[String(k).toLowerCase()]; }
}

function makeResponse(body, opts = {}) {
  const status = opts.status === undefined ? 200 : opts.status;
  return {
    body,
    status,
    statusText: opts.statusText || '',
    headers: opts.headers || new FakeHeaders(),
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
    Headers: FakeHeaders,
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

// The regression this pins: answering an ad endpoint locally (a `{}` with status 200,
// or `about:blank` on the XHR path) makes YouTube's player stop the video at the ad
// break it never gets a response for. Every ad URL must therefore reach the network
// untouched, and the ad has to be removed by stripping the payload instead.
test('ad endpoint requests reach the network, they are never answered locally', async () => {
  const handle = boot();
  handle.setNextBody('{"served":"by-the-network"}');
  const urls = [
    'https://www.youtube.com/youtubei/v1/player/ad_break?key=1',
    'https://www.youtube.com/get_midroll_info?x=1',
    'https://www.youtube.com/youtubei/v1/log_event?alt=json',
    'https://www.youtube.com/pagead/id',
    'https://googleads.g.doubleclick.net/pagead/id',
  ];
  for (const url of urls) {
    const resp = await handle.ctx.window.fetch(url);
    assert.strictEqual(await resp.text(), '{"served":"by-the-network"}',
      `${url} must be answered by the network, not by the userscript`);
    assert.deepStrictEqual(handle.log.fetch.at(-1).input, url, `${url} must reach fetch`);
  }
  assert.strictEqual(handle.log.fetch.length, urls.length, 'every ad URL is passed through');
});

test('an ad URL keeps its XHR address instead of being redirected to about:blank', () => {
  const { ctx } = boot();
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('GET', 'https://www.youtube.com/get_midroll_info?x=1');
  assert.strictEqual(xhr.openedUrl, 'https://www.youtube.com/get_midroll_info?x=1',
    'a rewritten address is what stalls the player: the ad break never completes');
  xhr.send(null);
  assert.strictEqual(xhr.sentBody, null);
});

test('the outgoing player request has its ad fields stripped, and only that request', async () => {
  const { ctx, log } = boot();
  const body = JSON.stringify({ adSlots: [1], videoId: 'x', streamingData: { formats: [{ itag: 18 }] } });
  await ctx.window.fetch('https://www.youtube.com/youtubei/v1/player?key=1', { method: 'POST', body });
  assert.strictEqual(log.fetch.length, 1);
  const sent = JSON.parse(log.fetch[0].init.body);
  assert.strictEqual(sent.adSlots, undefined, 'the ad schedule must not be requested');
  assert.strictEqual(sent.videoId, 'x', 'everything else survives');
  assert.deepStrictEqual(sent.streamingData, { formats: [{ itag: 18 }] });
  // a NON-player endpoint must keep its exact bytes
  await ctx.window.fetch('https://www.youtube.com/api/stats/watchtime', { body });
  assert.strictEqual(log.fetch[1].init.body, body, 'non-player bodies must not be rewritten');
  // a player URL with no init at all must not throw
  await ctx.window.fetch('https://www.youtube.com/youtubei/v1/player?key=1');
  assert.strictEqual(log.fetch.length, 3);
});

test('stripRequestAds only ever touches a JSON object request body', () => {
  const ctx = sandbox(slice(['var AD_FIELDS', 'stripAds', 'walkAds', 'stripRequestAds']));
  assert.strictEqual(ctx.stripRequestAds(null), null);
  assert.strictEqual(ctx.stripRequestAds(12345), null);
  assert.strictEqual(ctx.stripRequestAds('x'), null);
  // a JSON *number* parses but is not a request body: the head check rejects it
  assert.strictEqual(ctx.stripRequestAds('1234567'), null);
  // a body with no ad fields is handed back untouched (null = "keep the original")
  assert.strictEqual(ctx.stripRequestAds('{}'), null);
  assert.ok(!ctx.stripRequestAds('{"adSlots":[1],"x":2}').includes('adSlots'));
});

test('the player response is pruned before the page reads it', async () => {
  const handle = boot();
  handle.setNextBody(JSON.stringify({ adPlacements: [1], streamingData: { ok: 1 } }));
  const resp = await handle.ctx.window.fetch('https://www.youtube.com/youtubei/v1/player?key=1');
  const out = JSON.parse(await resp.text());
  assert.strictEqual(out.adPlacements, undefined, 'the ad schedule must not reach the player');
  assert.deepStrictEqual(out.streamingData, { ok: 1 });
});

test('an XHR to a non-player endpoint keeps its own body', () => {
  const { ctx } = boot();
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('POST', 'https://www.youtube.com/api/stats/playback');
  xhr.readyState = 4;
  xhr.responseType = '';
  xhr._responseText = JSON.stringify({ adSlots: [1], ok: true });
  xhr.fire('readystatechange');
  assert.deepStrictEqual(JSON.parse(xhr.responseText).adSlots, [1],
    'only player/next responses may be rewritten');
});

test('a fetch with no arguments is passed through, not thrown on', async () => {
  const { ctx, log } = boot();
  await ctx.window.fetch();
  assert.strictEqual(log.fetch.length, 1, 'the call still reaches the network layer');
  assert.strictEqual(log.fetch[0].input, undefined);
});

test('a first sample with no media never triggers a repair', () => {
  const loads = [];
  const video = { currentTime: 0, duration: NaN, readyState: 0 };
  const player = {
    classList: { contains: () => false }, getPlayerState: () => -1,
    loadVideoById: () => loads.push(1),
  };
  const ctx = sandbox(
    slice(['adShowing', 'sbVideoId', 'var progress', 'repairStalledVideo']),
    {
      document: { querySelector: (sel) => (sel.indexOf('ad-showing') !== -1 ? null
        : (sel.indexOf('video.html5-main-video') !== -1 ? video : player)) },
      location: { search: '?v=dQw4w9WgXcQ', pathname: '/watch' },
    });
  // The player has never had a duration: this is a page still loading, not a stall.
  for (let i = 0; i < 8; i++) assert.strictEqual(ctx.repairStalledVideo(1000 + i * 100), false);
  assert.strictEqual(loads.length, 0);
});

test('XHR responses are stripped at readystatechange and the patch stays configurable', () => {
  const { ctx } = boot();
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('POST', 'https://www.youtube.com/youtubei/v1/player?key=1');
  xhr.send(JSON.stringify({ adSlots: [1], videoId: 'x' }));
  assert.strictEqual(JSON.parse(xhr.sentBody).adSlots, undefined,
    'request ads are stripped on the XHR path too');
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

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

// Asserts the behaviour of reader/reader.js as observed in a real browser engine.
//
// tests/js/qt_harness.py loads the actual reader page (real reader.js + readability.js) in an
// offscreen QtWebEngine view, drives it through its states and prints one OBSERVATIONS json
// line. Until now nothing consumed that output, so the harness — and everything it proves —
// contributed nothing to reader.js's mutation score.
//
// The harness needs PyQt6 (and QtWebEngine). Where it is absent the whole file is SKIPPED
// explicitly rather than silently passing: a skipped assertion must never look like a
// satisfied one. CI installs PyQt6 so these run there.
// CommonJS on purpose: tools/policy_check.py compiles every .js file with `new vm.Script`,
// which treats a file as a script, so an ESM `import` is a syntax error there even though
// node --test accepts it. Using require() keeps the file valid under both.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const here = __dirname;
const harness = path.join(here, 'qt_harness.py');

function havePyQt6() {
  try {
    execFileSync('/usr/bin/python3', ['-c', 'import PyQt6.QtWebEngineWidgets'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

let OBS = null;
let reason = '';
if (!havePyQt6()) {
  reason = 'PyQt6/QtWebEngine not installed (CI installs python3-pyqt6)';
} else {
  try {
    const out = execFileSync('/usr/bin/python3', [harness], { encoding: 'utf8', timeout: 180000 });
    const line = out.split('\n').find((l) => l.startsWith('OBSERVATIONS:'));
    OBS = JSON.parse(line.slice('OBSERVATIONS:'.length));
  } catch (e) {
    reason = 'harness failed to run: ' + (e.message || e);
  }
}

const opts = OBS ? {} : { skip: reason };

test('the harness produced observations', opts, () => {
  assert.ok(OBS, reason);
  assert.ok(OBS.main, 'main scenario present');
  assert.equal(OBS.main.__done, true, 'main scenario ran to completion');
});

// ── block building and media splicing ────────────────────────────────────────
test('blocks and media are spliced in document order', opts, () => {
  const m = OBS.main;
  assert.equal(m.blkCount, 7, 'paragraph blocks');
  assert.equal(m.mediaBlocks, 2, 'media blocks kept');
  // media is anchored by element identity, so each sits AFTER its own paragraph
  assert.deepEqual(m.mediaPositions, [5, 7], 'media positions');
  assert.equal(m.labels0[5], 'MEDIA:video');
  assert.equal(m.labels0[7], 'MEDIA:iframe');
});

test('the reader chrome is built per block', opts, () => {
  const m = OBS.main;
  assert.equal(m.aiBtnCount, 7, 'an AI button per block');
  assert.equal(m.aiBadgeCount, 7, 'an AI badge per block');
  assert.equal(m.activeIdx0, 0, 'the first block starts active');
});

// ── the AI paragraph score ───────────────────────────────────────────────────
test('scoring a paragraph posts its text and paints the verdict', opts, () => {
  const m = OBS.main;
  assert.equal(m.markFetched, true);
  assert.equal(m.markFetchUrl.url, '/ai?t=tok123');
  assert.equal(m.markFetchUrl.method, 'POST');
  assert.match(m.markFetchUrl.body, /"mode":"paragraph"/);
  assert.match(m.markFetchUrl.body, /Test Headline Here/);
  assert.equal(m.markedBadge, 'AI 87%', 'the returned likelihood is shown');
  assert.match(m.markedClassed, /marked/);
});

// ── fact-checking, the card and the wheel ────────────────────────────────────
test('a fact-check renders a verdict card AND a supporting-article wheel', opts, () => {
  const m = OBS.main;
  assert.equal(m.factCard, true, 'verdict card rendered');
  assert.match(m.factCardText, /SUPPORTED/);
  assert.match(m.factCardText, /80%/);
  // the wheel is the part that silently did not appear before
  assert.equal(m.factWheel, true, 'the wheel rendered beside the paragraph');
  assert.equal(m.wheelItems, 2, 'one item per supporting article');
  assert.match(m.wheelCounter, /Outlet A/);
  assert.match(m.factStatus, /focuses the article wheel/);
});

test('the wheel takes focus, moves, opens and gives focus back', opts, () => {
  const m = OBS.main;
  assert.equal(m.wheelFocused0, true, '→ focuses the wheel');
  assert.equal(m.curIdx0, 0, 'it starts on the first item');
  assert.equal(m.curAfterDown, 1, '↓ moves down the wheel');
  assert.match(m.wheelStatusAfterDown, /2\/2/);
  assert.equal(m.curAfterUp, 0, '↑ moves back');
  assert.deepEqual(m.opened, ['https://a.example/1'], 'Enter opens the item');
  assert.match(m.openStatus, /Opened: Outlet A/);
  assert.equal(m.wheelFocusedAfterEsc, false, 'Esc leaves the wheel');
  assert.equal(m.wheelFocusLeftCleared, true, 'and focus returns to the paragraph');
  assert.match(m.wheelLeftStatus, /Paragraph focus/);
});

// ── the whole-article pass ───────────────────────────────────────────────────
test('a whole-article fact-check gives EVERY paragraph its wheel', opts, () => {
  const m = OBS.main;
  assert.equal(m.wheelsAfterAll, 3, 'a wheel per fact-checked paragraph');
  assert.equal(m.cardsAfterAll, 3, 'and a card per paragraph');
  assert.match(m.statusAfterAll, /Fact-checked 3 paragraph\(s\)/);
});

// ── the summary ──────────────────────────────────────────────────────────────
test('the summary is the first block and does not steal focus', opts, () => {
  const m = OBS.main;
  assert.equal(m.summaryBlk, true);
  assert.equal(m.summaryIsFirst, true, 'inserted above the title');
  assert.equal(m.summaryBullets, 2, 'one bullet per point');
  assert.equal(m.promoWarning, true, 'promotional content is flagged');
  // the crash was here: focus must survive the rebuild
  assert.equal(m.activeAfterSummary, 1, 'the active paragraph is preserved');
  assert.equal(m.summaryFetchCount, 1, 'the summary is fetched once');
});

// ── removal and undo ─────────────────────────────────────────────────────────
test('AI-written paragraphs can be removed and restored', opts, () => {
  const m = OBS.main;
  assert.equal(m.blkBeforeRemove, 7);
  assert.equal(m.blkAfterRemove, 6, 'one paragraph removed');
  assert.equal(m.undoShown, true, 'undo appears');
  assert.match(m.removedStatus, /Removed 1 AI-written paragraph\(s\)/);
  assert.equal(m.blkAfterRestore, 7, 'undo restores it');
  assert.equal(m.undoHiddenAfterRestore, true);
});

// ── persistence ──────────────────────────────────────────────────────────────
test('state is persisted and beaconed to the server', opts, () => {
  const m = OBS.main;
  assert.ok(m.savedKeys >= 1, 'paragraph state saved by text key');
  assert.ok(m.beaconCount >= 1, 'state beaconed');
  assert.match(m.beaconUrls[0], /^\/state\?t=/);
  const p = Object.values(m.savedState.paras)[0];
  assert.ok(Array.isArray(p.summary), 'the summary is part of saved state');
  const f = Object.values(m.savedState.facts)[0];
  assert.ok('verdict' in f && 'headlines' in f, 'facts are saved with their headlines');
});

// ── the reader chrome: mode, colours, media controls ─────────────────────────
test('the reader takes its mode and colours from the page', opts, () => {
  const m = OBS.main;
  assert.equal(m.mode, 'light', 'data-mode follows the injected colours');
  assert.equal(m.cssBg, '#0b0b0b', '--bg is set from the colours map');
  assert.equal(m.cssAccent, '#11aa33', '--accent is set from the colours map');
});

test('a spliced video carries native controls', opts, () => {
  assert.equal(OBS.main.videoControls, true);
});

// ── stepping through paragraphs lights exactly one block ─────────────────────
test('moving down and back up lights exactly one paragraph', opts, () => {
  const m = OBS.main;
  assert.equal(m.activeAfterJ, 1, 'j steps down one paragraph');
  assert.equal(m.activeCountAfterJ, 1, 'only one paragraph stays lit');
  assert.equal(m.activeAfterK, 0, 'k steps back up');
});

test('↑ on the first paragraph summarises the article, it does not move', opts, () => {
  // Regression: upOnce() must summarise when the first paragraph is active (there is
  // nowhere above to go), not scroll up.
  assert.equal(OBS.main.upOnceSummarized, 1);
});

test('undo restores the paragraph and re-lights the active block', opts, () => {
  assert.equal(OBS.main.activeAfterRestore, 1);
});

test('stepping to another paragraph releases a focused wheel', opts, () => {
  // setActive() must blur the wheel; otherwise it keeps .focused and swallows ↑/↓.
  const m = OBS.main;
  assert.equal(m.wheelFocusedBeforeBlockClick, true, 'the wheel is focused first');
  assert.equal(m.wheelFocusedAfterBlockClick, false, 'stepping away releases it');
});

// ── error handling ───────────────────────────────────────────────────────────
test('an AI HTTP error is reported in the status bar', opts, () => {
  const e = OBS.ai_error;
  assert.ok(e, 'ai_error scenario ran');
  assert.equal(e.__done, true);
  assert.match(e.errorStatus, /^AI error: HTTP 500$/);
  assert.equal(e.errorClass, true, 'the status is flagged as an error');
});

test('a malformed AI response is reported, not silently swallowed', opts, () => {
  const b = OBS.badjson;
  assert.ok(b, 'badjson scenario ran');
  assert.equal(b.__done, true);
  assert.match(b.badJsonStatus, /bad response/);
});

// ── restore ──────────────────────────────────────────────────────────────────
test('saved annotations are replayed when the article is reloaded', opts, () => {
  const r = OBS.restore;
  assert.ok(r, 'restore scenario ran');
  assert.equal(r.__done, true);
  assert.equal(r.summaryRestored, true, 'the summary comes back');
  assert.equal(r.restoredFacts, 2, 'the fact cards come back');
  assert.equal(r.restoredWheels, 2, 'and their wheels');
  assert.equal(r.removedRestored, 7, 'the removed paragraph is restored');
  // assert on the polled flag, not a single instantaneous read of #status
  assert.ok(r.sawRestoredStatus, 'the restore reports itself in the status line');
});

test('a saved position that matches no paragraph falls back to the saved scroll', opts, () => {
  assert.deepEqual(OBS.restore.scrollCalls, [0, 777]);
});

test('an empty saved state does not block later saves', opts, () => {
  const e = OBS.restore_empty;
  assert.ok(e, 'restore_empty scenario ran');
  assert.equal(e.__done, true);
  assert.ok(e.savedAfterEmptyRestore >= 1, 'saving resumes after an empty restore');
});

// ── media collection ─────────────────────────────────────────────────────────
test('the media collector drops trackers, keeps players and names embeds', opts, () => {
  const m = OBS.media;
  assert.ok(m, 'media scenario ran');
  assert.equal(m.__done, true);
  assert.equal(m.mediaCount, 12, 'collection stops at the readability cap');
  assert.equal(m.hasPixel, false, 'a 1x1 video is a tracker, not a player');
  assert.equal(m.hasWide, true, 'a 1-pixel-WIDE player is a real player');
  assert.ok(m.captions.includes('Embedded iframe'), 'a captionless embed is named');
});

// ── persistence key stability ────────────────────────────────────────────────
test('paragraph state is keyed by a stable hash of the paragraph text', opts, () => {
  // h32() is FNV-1a; the title paragraph's key must not drift or every previously
  // saved annotation would be orphaned on reload.
  assert.ok(OBS.main.savedState.marks['3f6ebeeb'], 'the title paragraph key is stable');
});

// ── resume position (visibleKey) ─────────────────────────────────────────────
test('the resume position is the lowest paragraph at or above the fold', opts, () => {
  const v = OBS.visiblekey;
  assert.ok(v, 'visiblekey scenario ran');
  assert.equal(v.__done, true);
  assert.equal(v.topA, v.threshold, 'block A sits exactly at the fold');
  assert.equal(v.topB, v.threshold, 'block B sits exactly at the fold');
  assert.equal(v.savedPos, v.keyA, 'of two tied paragraphs the earlier one wins');
  assert.notEqual(v.keyA, v.keyActive, 'the saved position is not merely the active block');
});


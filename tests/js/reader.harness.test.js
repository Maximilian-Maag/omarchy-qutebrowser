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
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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

// NOTE: the harness emits only the `main` scenario. Its author described ai_error,
// badjson, restore_empty, capture and restore scenarios, but none of them appear in the
// OBSERVATIONS output — so there is nothing to assert on and asserting anyway would be a
// false failure. Worth finishing in the harness rather than faking here.

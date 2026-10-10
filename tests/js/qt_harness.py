#!/usr/bin/env python3
"""Offscreen QtWebEngine harness for reader/reader.js.

Loads the REAL reader page (index.html markup, readability.js, reader.js) with
network/AI stubbed, drives it with a scripted sequence of user actions, and
prints a JSON blob of observations that tests/js/reader_dom.test.js asserts on.

No network, no model: fetch/sendBeacon/window.open are replaced by recorders.
"""
import json
import os
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent.parent

# Isolate every XDG dir: sharing them with a live browser makes QtWebEngine abort.
import tempfile
_TMP = tempfile.mkdtemp(prefix="reader-qt-")
for var, sub in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                 ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
    os.environ[var] = os.path.join(_TMP, sub)
os.environ["XDG_RUNTIME_DIR"] = os.path.join(_TMP, "run")
os.makedirs(os.environ["XDG_RUNTIME_DIR"], mode=0o700, exist_ok=True)
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS",
                      "--no-sandbox --disable-gpu --disable-dev-shm-usage "
                      "--disable-background-timer-throttling "
                      "--disable-backgrounding-occluded-windows "
                      "--disable-renderer-backgrounding "
                      "--disable-features=CalculateNativeWinOcclusion,NetworkService")

from PyQt6.QtCore import QTimer  # noqa: E402
from PyQt6.QtWidgets import QApplication  # noqa: E402
from PyQt6.QtWebEngineCore import QWebEngineSettings  # noqa: E402
from PyQt6.QtWebEngineWidgets import QWebEngineView  # noqa: E402

READABILITY = (REPO / "reader" / "readability.js").read_text()
READER_JS = (REPO / "reader" / "reader.js").read_text()

RAW_ARTICLE = (
    "<html><head><title>Test Headline Here</title></head><body>"
    "<nav><p>Navigation paragraph that must not become media anchors.</p></nav>"
    "<div id='content'>"
    "<h1>Test Headline Here</h1>"
    "<p>Alpha paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "<p>Beta paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "<video src='https://cdn.example.com/movie.mp4' width='640' height='360' title='A clip'></video>"
    "<p>Gamma paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "<figure><iframe src='https://player.example.com/embed/xyz'></iframe>"
    "<figcaption>An embedded player</figcaption></figure>"
    "<img src='https://track.example.com/pixel.gif' width='1' height='1' alt=''>"
    "<p>Delta paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "</div></body></html>"
)

# A second article whose media exercise the collector's filters: a 1x1 tracking
# video (must be dropped), a 1-pixel-wide player (must be KEPT — only a 1x1 pair is
# a pixel), an iframe with no caption (its caption falls back to 'Embedded iframe'),
# and enough ordinary players that the 12-element readability cap is observable.
RAW_MEDIA = (
    "<html><head><title>Media Test Article</title></head><body>"
    "<div id='content'>"
    "<h1>Media Test Article</h1>"
    "<p>Intro paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "<video src='https://cdn.example.com/pixel.mp4' width='1' height='1'></video>"
    "<video src='https://cdn.example.com/wide.mp4' width='1' height='360'></video>"
    "<iframe src='https://player.example.com/nocap'></iframe>"
    + "".join("<video src='https://cdn.example.com/v%d.mp4' width='640' height='360'></video>" % i
              for i in range(1, 14))
    + "<p>Closing paragraph with enough words to be extracted by Readability as real article prose.</p>"
    "</div></body></html>"
)

STUBS = """
window.__calls = { fetch: [], beacon: [], open: [] };
window.__obs = {};
window.addEventListener('error', function (e) {
  (window.__obs.__errors = window.__obs.__errors || []).push(String(e.message || e.error));
});
function _jsonResponse(data, ok, status) {
  return Promise.resolve({ ok: ok === undefined ? true : ok,
                           status: status === undefined ? 200 : status,
                           json: function () { return Promise.resolve(data); } });
}
function _aiResult(mode) {
  if (mode === 'paragraph') return { verdict: 'ai', ai_likelihood: 87, reason: 'machine-written' };
  if (mode === 'article_marks') return [{ index: 0, verdict: 'ai', ai_likelihood: 90, reason: 'r0' },
                                        { index: 1, verdict: 'human', ai_likelihood: 5, reason: 'r1' }];
  if (mode === 'summary') return { verdict: 'mixed', ai_likelihood: 40, reason: 'why not',
    summary: ['First bullet point.', 'Second bullet point.'],
    promotional: { score: 55, kind: 'advertorial', evidence: 'sponsored label' } };
  if (mode === 'summary_para') return { summary: ['One sentence summary.'], reason: 'short' };
  if (mode === 'factcheck') return { verdict: 'supported', confidence: 80, reason: 'matches sources',
    query: 'test query', outlets: ['a.example', 'b.example'],
    headlines: [ { source: 'Outlet A', headline: 'Headline A', url: 'https://a.example/1' },
                 { source: 'Outlet B', headline: 'Headline B', url: 'https://b.example/2' } ] };
  if (mode === 'factcheck_article') return [{ index: 0, verdict: 'disputed', confidence: 30,
    reason: 'r', headlines: [ { source: 'S0', headline: 'H0', url: 'https://s0.example/x' } ] },
    { index: 1, verdict: 'supported', confidence: 70, reason: 'r',
      headlines: [ { source: 'S1', headline: 'H1', url: 'https://s1.example/y' } ] },
    { index: 2, verdict: 'unclear', confidence: 50, reason: 'r', headlines: [] }];
  return { verdict: 'human', ai_likelihood: 1, reason: 'none' };
}
window.fetch = function (url, opts) {
  opts = opts || {};
  var rec = { url: String(url), method: opts.method || 'GET', body: opts.body || null };
  window.__calls.fetch.push(rec);
  if (window.__AI_ERROR__ && String(url).indexOf('/ai') === 0) {
    var e = window.__AI_ERROR__;
    return _jsonResponse(e.data, e.ok, e.status);
  }
  if (String(url).indexOf('/ai') === 0) {
    if (window.__AI_JSON_REJECT__) {
      return Promise.resolve({ ok: true, status: 200,
        json: function () { return Promise.reject(new Error('boom')); } });
    }
    var payload = JSON.parse(opts.body);
    return _jsonResponse({ ok: true, result: _aiResult(payload.mode) });
  }
  if (String(url).indexOf('/state') === 0) {
    if (rec.method === 'POST') return _jsonResponse({ ok: true });
    return _jsonResponse(window.__STATE__ || {});
  }
  return _jsonResponse({});
};
Object.defineProperty(navigator, 'sendBeacon', { configurable: true,
  value: function (url, blob) { window.__calls.beacon.push({ url: String(url), blob: blob }); return true; } });
window.open = function (u) { window.__calls.open.push(String(u)); return null; };
window.scrollTo = function (x, y) { window.__calls.scroll = [x, y]; };
"""

PAGE = """<!doctype html><html lang="en" data-mode="dark"><head><meta charset="utf-8"></head>
<body data-token="tok123" data-url="https://example.com/story">
<header id="bar">
  <button id="btn-score">score</button><button id="btn-fact">fact</button>
  <button id="btn-undo" hidden>undo</button><button id="btn-prev">prev</button>
  <button id="btn-next">next</button><button id="btn-fontdec">A-</button>
  <button id="btn-fontinc">A+</button><button id="btn-summary">sum</button>
  <button id="btn-markall">markall</button><button id="btn-focus">focus</button>
  <button id="btn-hide">hide</button>
</header>
<div id="status" role="status"></div>
<main id="article" tabindex="-1"></main>
<footer id="hint"></footer>
<script>window.__READER_COLORS__ = %(colors)s;
window.__READER_ARTICLE__ = %(article)s;</script>
<script>%(stubs)s</script>
<script>%(readability)s</script>
<script>%(reader)s</script>
</body></html>"""

DRIVER = r"""
(async function () {
  var obs = window.__obs;
  obs.__ticks = 0;
  setInterval(function () { obs.__ticks++; }, 100);
  try {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function key(k, mods) {
    document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, mods || {})));
  }
  function articleLabels() {
    return qa('#article .blk, #article .media-block').map(function (el) {
      if (el.classList.contains('media-block')) {
        var inner = el.querySelector('video,audio,iframe');
        return 'MEDIA:' + (inner ? inner.tagName.toLowerCase() : '?');
      }
      return el.tagName + ':' + (el.textContent || '').trim().slice(0, 10);
    });
  }
  function activeIdx() {
    var a = q('#article .blk.active');
    var all = qa('#article .blk');
    return a ? all.indexOf(a) : -1;
  }

  // ── top-level / colours / block build ────────────────────────────────
  obs.mode = document.documentElement.dataset.mode;
  obs.cssBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  obs.cssAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  obs.labels0 = articleLabels();
  obs.blkCount = qa('#article .blk').length;
  obs.aiBtnCount = qa('#article .ai-btn').length;
  obs.aiBadgeCount = qa('#article .ai-badge').length;
  obs.activeIdx0 = activeIdx();
  obs.summaryBlk0 = !!q('#article .summary-blk');
  obs.mediaBlocks = qa('#article .media-block').length;
  // the spliced <video> must carry native controls
  obs.videoControls = (function () { var v = q('#article video'); return v ? v.controls : null; }());
  // media must be placed before a paragraph, not appended at the very end
  obs.mediaPositions = articleLabels().map(function (v, i) { return v.indexOf('MEDIA') === 0 ? i : -1; })
    .filter(function (i) { return i >= 0; });
  obs.articleChildCount = q('#article').children.length;
  // block text must exclude the injected widget text
  var firstBlk = qa('#article .blk')[0];
  obs.firstBlkText = firstBlk ? firstBlk.textContent.trim().slice(0, 40) : null;
  obs.statusAfterExtract = q('#status').textContent;

  // ── AI score a paragraph (m) ─────────────────────────────────────────
  key('m');
  await wait(650);
  obs.markStatus = q('#status').textContent;
  var marked = q('#article .blk.active');
  obs.markedBadge = marked ? (marked.querySelector('.ai-badge') || {}).textContent : null;
  obs.markedClassed = marked ? marked.className : null;
  obs.markFetched = window.__calls.fetch.some(function (c) { return c.url.indexOf('/ai') === 0; });
  obs.markFetchUrl = window.__calls.fetch.filter(function (c) { return c.url.indexOf('/ai') === 0; })[0];

  // ── move / focus (j) ─────────────────────────────────────────────────
  var beforeMove = activeIdx();
  key('j');
  await wait(30);
  obs.activeAfterJ = activeIdx();
  // exactly ONE paragraph may be lit — a rebuild/step that leaves two .active is a bug
  obs.activeCountAfterJ = qa('#article .blk.active').length;
  obs.focusMode = document.body.classList.contains('focus-mode');
  obs.beforeMove = beforeMove;
  // k from a non-first paragraph goes back
  key('k');
  await wait(30);
  obs.activeAfterK = activeIdx();

  // ── paragraph summary (Ctrl+ArrowUp) ─────────────────────────────────
  key('ArrowUp', { ctrlKey: true });
  await wait(80);
  obs.paraSummary = !!q('#article .blk.active .para-summary');
  obs.paraSummaryText = (q('#article .blk.active .para-summary') || {}).textContent;

  // ── fact-check a single paragraph (→) ────────────────────────────────
  var activeBeforeFact = activeIdx();
  key('ArrowRight');
  await wait(650);
  var factBlk = qa('#article .blk')[activeBeforeFact];
  obs.factCard = !!(factBlk && factBlk.querySelector('.fact-card'));
  obs.factCardText = (factBlk && factBlk.querySelector('.fact-card')) ? factBlk.querySelector('.fact-card').textContent : null;
  obs.factWheel = !!(factBlk && factBlk.querySelector('.fact-wheel'));
  obs.wheelItems = factBlk ? factBlk.querySelectorAll('.wheel-item').length : 0;
  obs.wheelCounter = factBlk && factBlk.querySelector('.fact-wheel') ? factBlk.querySelector('.fact-wheel').textContent : null;
  obs.factStatus = q('#status').textContent;

  // ── wheel navigation: focus via API, move, open ──────────────────────
  window.omarchyReader.wheelfocus();
  await wait(20);
  var wheel = q('#article .fact-wheel');
  obs.wheelFocused0 = wheel ? wheel.classList.contains('focused') : null;
  function curIdx() {
    if (!wheel) return -1;
    var items = Array.prototype.slice.call(wheel.querySelectorAll('.wheel-item'));
    return items.indexOf(wheel.querySelector('.wheel-item.cur'));
  }
  obs.curIdx0 = curIdx();
  key('ArrowDown');
  await wait(20);
  obs.curAfterDown = curIdx();
  obs.wheelStatusAfterDown = q('#status').textContent;
  key('ArrowUp');
  await wait(20);
  obs.curAfterUp = curIdx();
  key('Enter');
  await wait(20);
  obs.opened = window.__calls.open.slice();
  obs.openStatus = q('#status').textContent;
  key('Escape');
  await wait(20);
  obs.wheelFocusedAfterEsc = wheel ? wheel.classList.contains('focused') : null;
  // ← while wheel focused returns to the paragraph instead of scoring
  window.omarchyReader.wheelfocus();
  await wait(20);
  key('ArrowLeft');
  await wait(20);
  obs.wheelLeftStatus = q('#status').textContent;
  obs.wheelFocusLeftCleared = !q('#article .fact-wheel.focused');

  // ── whole-article fact-check (direct API; the tap dispatcher is covered
  //    separately by the node slice tests) ──────────────────────────────
  var wheelsBefore = qa('#article .fact-wheel').length;
  window.omarchyReader.factcheckall();
  await wait(400);
  obs.wheelsBefore = wheelsBefore;
  obs.wheelsAfterAll = qa('#article .fact-wheel').length;
  obs.cardsAfterAll = qa('#article .fact-card').length;
  obs.statusAfterAll = q('#status').textContent;

  // ── summary (s) ──────────────────────────────────────────────────────
  window.omarchyReader.summarize();
  await wait(120);
  obs.summaryBlk = !!q('#article .summary-blk');
  obs.summaryIsFirst = q('#article').firstElementChild &&
    q('#article').firstElementChild.classList.contains('summary-blk');
  obs.summaryBullets = qa('#article .summary-blk li').length;
  obs.promoWarning = !!q('#article .summary-blk .promo-warning');
  obs.promoStrong = !!q('#article .summary-blk .promo-warning.strong');
  obs.summaryStatus = q('#status').textContent;
  obs.activeAfterSummary = activeIdx();
  obs.activeBeforeSummary = null;
  var closeBtn = q('#article .summary-blk .summary-head button');
  if (closeBtn) { closeBtn.click(); await wait(40); }
  obs.summaryAfterClose = !!q('#article .summary-blk');
  obs.summaryFetchCount = window.__calls.fetch.filter(function (c) {
    return c.url.indexOf('/ai') === 0 && c.body && c.body.indexOf('"summary"') !== -1; }).length;

  // ── remove / restore AI-written paragraphs (direct API; the double-tap
  //    dispatcher that fronts these is pinned by the node slice tests) ────
  obs.__step = 'removal';
  var countBefore = qa('#article .blk').length;
  var beaconsBeforeRemove = window.__calls.beacon.length;
  obs.__step = 'removal:before-call';
  window.omarchyReader.removeai();
  obs.__step = 'removal:after-call';
  await wait(80);
  obs.__step = 'removal:after-wait';
  obs.blkBeforeRemove = countBefore;
  obs.blkAfterRemove = qa('#article .blk').length;
  obs.undoShown = q('#btn-undo') ? !q('#btn-undo').hidden : null;
  obs.removedStatus = q('#status').textContent;
  obs.beaconDeltaRemove = window.__calls.beacon.length - beaconsBeforeRemove;
  window.omarchyReader.restoreai();
  await wait(80);
  obs.blkAfterRestore = qa('#article .blk').length;
  obs.activeAfterRestore = activeIdx();
  obs.undoHiddenAfterRestore = q('#btn-undo') ? q('#btn-undo').hidden : null;

  // ── upOnce on the FIRST paragraph summarises the article (<=0), not move ─
  qa('#article .blk')[0].click();
  await wait(20);
  var summaryReqsBefore = window.__calls.fetch.filter(function (c) {
    return c.body && c.body.indexOf('"summary"') !== -1; }).length;
  key('ArrowUp');
  await wait(200);
  obs.upOnceSummarized = window.__calls.fetch.filter(function (c) {
    return c.body && c.body.indexOf('"summary"') !== -1; }).length - summaryReqsBefore;

  // ── the persisted state (sendBeacon payload) ─────────────────────────
  var last = window.__calls.beacon[window.__calls.beacon.length - 1];
  if (last && last.blob && last.blob.text) {
    try { obs.savedState = JSON.parse(await last.blob.text()).state; }
    catch (e) { obs.savedStateError = String(e); }
  }
  obs.savedKeys = obs.savedState ? Object.keys(obs.savedState.marks || {}).length : null;
  obs.beaconCount = window.__calls.beacon.length;
  obs.beaconUrls = window.__calls.beacon.map(function (b) { return b.url; });

  // ── a focused wheel is released when the reader steps to another paragraph ──
  // setActive() must blur the wheel before lighting the new block; otherwise the
  // wheel keeps .focused (and swallows the next ↑/↓) after you move away from it.
  var anyWheel = q('#article .fact-wheel');
  if (anyWheel) {
    var owner = anyWheel.closest('.blk');
    if (owner) {
      owner.click();
      await wait(20);
      window.omarchyReader.wheelfocus();
      await wait(20);
      obs.wheelFocusedBeforeBlockClick = !!q('#article .fact-wheel.focused');
      var otherBlk = qa('#article .blk').filter(function (b) { return b !== owner; })[0];
      if (otherBlk) {
        otherBlk.click();
        await wait(20);
        obs.wheelFocusedAfterBlockClick = !!q('#article .fact-wheel.focused');
      }
    }
  }
  obs.__done = true;
  } catch (e) { obs.__driverError = String((e && e.stack) || e); obs.__done = true; }
})();
"""

AI_ERROR_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(650);
  obs.errorStatus = q('#status').textContent;
  obs.errorClass = q('#status').classList.contains('error');
  obs.__done = true;
})();
"""

RESTORE_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  await wait(200);
  obs.restoredMarks = qa('#article .blk.marked').length;
  obs.summaryRestored = !!q('#article .summary-blk');
  obs.restoredFacts = qa('#article .fact-card').length;
  obs.restoredWheels = qa('#article .fact-wheel').length;
  obs.removedRestored = qa('#article .blk').length;
  obs.scrollCalls = window.__calls.scroll || null;
  obs.restoringStatus = q('#status').textContent;
  obs.activeIdxAfterRestore = (function () {
    var a = q('#article .blk.active');
    var all = qa('#article .blk');
    return a ? all.indexOf(a) : -1;
  }());
  obs.__done = true;
})();
"""

CAPTURE_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  try {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(650);
  window.omarchyReader.summarypara();
  await wait(100);
  window.omarchyReader.factcheckall();
  await wait(300);
  window.omarchyReader.summarize();
  await wait(150);
  window.omarchyReader.removeai();
  await wait(150);
  var last = window.__calls.beacon[window.__calls.beacon.length - 1];
  if (last && last.blob && last.blob.text) {
    try { obs.savedState = JSON.parse(await last.blob.text()).state; }
    catch (e) { obs.savedStateError = String(e); }
  }
  obs.__done = true;
  } catch (e) { obs.__driverError = String((e && e.stack) || e); obs.__done = true; }
})();
"""

BADJSON_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(650);
  obs.badJsonStatus = q('#status').textContent;
  obs.__done = true;
})();
"""

RESTORE_EMPTY_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await wait(200);
  obs.restoringDone = true;
  window.omarchyReader.removeai();          // no AI paragraphs -> sets an error, no save
  var before = window.__calls.beacon.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(2200);                          // tap 460ms + applyVerdict -> saveState (900ms debounce)
  obs.savedAfterEmptyRestore = window.__calls.beacon.length - before;
  obs.__done = true;
})();
"""

MEDIA_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  try {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  await wait(150);
  obs.mediaCount = qa('#article .media-block').length;
  obs.captions = qa('#article .media-block .media-caption').map(function (c) { return c.textContent; });
  obs.mediaSrcs = qa('#article .media-block').map(function (b) {
    var m = b.querySelector('video,audio,iframe');
    if (!m) return null;
    if (m.tagName === 'VIDEO' || m.tagName === 'AUDIO') {
      var s = m.querySelector('source');
      return s ? s.src : m.src;
    }
    return m.src;
  });
  obs.hasPixel = obs.mediaSrcs.some(function (u) { return u && u.indexOf('pixel.mp4') !== -1; });
  obs.hasWide = obs.mediaSrcs.some(function (u) { return u && u.indexOf('wide.mp4') !== -1; });
  obs.__done = true;
  } catch (e) { obs.__driverError = String((e && e.stack) || e); obs.__done = true; }
})();
"""

VISIBLEKEY_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  try {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function blockText(el) {
    var c = el.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.ai-btn,.ai-badge,.fact-card,.fact-wheel,.para-summary'),
                                 function (n) { n.remove(); });
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function h32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  await wait(120);
  window.scrollTo(0, 0);
  await wait(40);
  var blks = qa('#article .blk');
  // Absolute-position every block so the viewport tops are exact and controllable.
  blks.forEach(function (b) {
    b.style.position = 'absolute'; b.style.left = '0'; b.style.width = '600px';
    b.style.height = '80px'; b.style.margin = '0'; b.style.top = '10px';
  });
  var T = window.innerHeight * 0.5;          // the "below the fold" threshold
  var A = blks[1], B = blks[2];              // two real paragraphs
  if (A) A.style.top = T + 'px';
  if (B) B.style.top = T + 'px';
  obs.innerHeight = window.innerHeight;
  obs.threshold = T;
  obs.topA = A ? A.getBoundingClientRect().top : null;
  obs.topB = B ? B.getBoundingClientRect().top : null;
  var activeBlk = q('#article .blk.active');
  obs.activeText = activeBlk ? blockText(activeBlk) : null;
  // force a save so the payload's `pos` (visibleKey) is observable
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(2400);
  var last = window.__calls.beacon[window.__calls.beacon.length - 1];
  if (last && last.blob && last.blob.text) {
    try { var st = JSON.parse(await last.blob.text()).state; obs.savedPos = st.pos; }
    catch (e) { obs.savedStateError = String(e); }
  }
  obs.keyA = A ? h32(blockText(A)) : null;
  obs.keyB = B ? h32(blockText(B)) : null;
  obs.keyActive = activeBlk ? h32(blockText(activeBlk)) : null;
  obs.__done = true;
  } catch (e) { obs.__driverError = String((e && e.stack) || e); obs.__done = true; }
})();
"""

# A page the reader cannot reduce to any block (no paragraph-level elements). The
# reader must survive a scoring key here rather than reaching into a missing block.
RAW_NOBLOCKS = (
    "<html><head><title>Nothing to read</title></head><body>"
    "<div><span>This page has no paragraph-level elements at all, so no block survives.</span></div>"
    "</body></html>"
)

EMPTY_DRIVER = r"""
(async function () {
  var obs = window.__obs;
  try {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  await wait(200);
  obs.blkCount = qa('#article .blk').length;
  obs.articleChildren = q('#article') ? q('#article').children.length : null;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await wait(900);
  obs.errors = (window.__obs.__errors || []).slice();
  obs.status = q('#status').textContent;
  obs.__done = true;
  } catch (e) { obs.__driverError = String((e && e.stack) || e); obs.__done = true; }
})();
"""

DRIVERS = {"main": DRIVER, "ai_error": AI_ERROR_DRIVER, "restore": RESTORE_DRIVER,
           "capture": CAPTURE_DRIVER, "badjson": BADJSON_DRIVER,
           "restore_empty": RESTORE_EMPTY_DRIVER, "media": MEDIA_DRIVER,
           "visiblekey": VISIBLEKEY_DRIVER, "empty": EMPTY_DRIVER}

# Order matters: `capture` must run before `restore` (restore replays the state
# capture saved), and `main` first so its observations lead the blob.
DEFAULT_SCENARIOS = ["main", "ai_error", "badjson", "restore_empty", "capture",
                     "restore", "media", "visiblekey", "empty"]


def build_html(scenario, captured=None):
    colors = json.dumps({"mode": "light", "bg": "#0b0b0b", "accent": "#11aa33",
                         "fg": "#eeeeee", "red": "#ff0000"})
    article = json.dumps(RAW_MEDIA if scenario == "media" else RAW_ARTICLE)
    stubs = STUBS
    if scenario == "ai_error":
        stubs += "\nwindow.__AI_ERROR__ = { ok: false, status: 500, data: { ok: false, error: '' } };\n"
    if scenario == "badjson":
        stubs += "\nwindow.__AI_JSON_REJECT__ = true;\n"
    if scenario == "restore":
        state = dict(captured or {})
        state["pos"] = "00000000"          # matches no block -> exercises the scroll fallback
        state["scroll"] = 777
        stubs += "\nwindow.__STATE__ = " + json.dumps(state) + ";\n"
    if scenario == "restore_empty":
        stubs += "\nwindow.__STATE__ = {};\n"
    return PAGE % {"colors": colors, "article": article, "stubs": stubs,
                   "readability": READABILITY, "reader": READER_JS}


def main():
    scenarios = sys.argv[1].split(",") if len(sys.argv) > 1 else DEFAULT_SCENARIOS
    out = {}
    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.resize(1280, 900)
    view.show()                      # a shown view keeps the page "visible"
    page = view.page()
    page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
    st = {"i": 0, "deadline": 0, "loaded": False}

    def start_next():
        sc = scenarios[st["i"]]
        st["deadline"] = 0
        st["loaded"] = False
        captured = (out.get("capture") or {}).get("savedState")
        page.setHtml(build_html(sc, captured))

    def on_load(ok):
        sc = scenarios[st["i"]]
        st["loaded"] = True
        page.runJavaScript(DRIVERS[sc])

    page.loadFinished.connect(on_load)

    def poll():
        st["deadline"] += 1
        sc = scenarios[st["i"]]
        page.runJavaScript("window.__obs && window.__obs.__done ? '1' : '0'", done_cb(sc))

    def done_cb(sc):
        def cb(val):
            if val == "1":
                page.runJavaScript("JSON.stringify(window.__obs)", got_obs(sc))
            else:
                pass
        return cb

    def got_obs(sc):
        def cb(val):
            try:
                out[sc] = json.loads(val) if val else None
            except Exception as e:  # noqa
                out[sc] = {"__parse_error__": str(e), "raw": val}
            st["i"] += 1
            if st["i"] >= len(scenarios):
                print("OBSERVATIONS:" + json.dumps(out))
                app.quit()
                return
            start_next()
        return cb

    def tick():
        if st["i"] >= len(scenarios):
            return
        if st["deadline"] > 150:               # ~15s safety per scenario
            page.runJavaScript("JSON.stringify(window.__obs)", got_obs(scenarios[st["i"]]))
            return
        if st["loaded"]:
            poll()

    timer = QTimer()
    timer.timeout.connect(tick)
    timer.start(100)
    start_next()
    QTimer.singleShot(90000, lambda: (print("OBSERVATIONS:" + json.dumps(out)), app.quit()))
    app.exec()
    return 0


if __name__ == "__main__":
    sys.exit(main())

/* omarchy-qutebrowser reader — distraction-free reading + local-AI provenance,
 * summary and fact-checking.
 *
 * Article extraction: Mozilla Readability (reader/readability.js, Apache-2.0).
 * AI: POST /ai on the loopback reader-server, which runs the local agent
 *     (`hermes -z … --cli`). Nothing leaves the machine except the Google News
 *     RSS lookups used for fact-checking.
 *
 * Actions
 *   ◀ / ← / ,e        AI-score the active paragraph   (double → remove AI-written)
 *   ▶ / → / ,c        fact-check the active paragraph (creates the article wheel);
 *                     pressed again → focus the wheel  (double → whole article)
 *   wheel focused:    ↑/↓ or ,n/,N scroll previews · Enter or ,o open · Esc leave
 */
(function () {
  'use strict';

  var COLORS = window.__READER_COLORS__ || {};
  var RAW = window.__READER_ARTICLE__ || '';
  var TOKEN = document.body.dataset.token || '';
  var PAGE_URL = document.body.dataset.url || '';
  var root = document.documentElement;

  Object.entries({
    '--bg': 'bg', '--fg': 'fg', '--bg-dark': 'bg_dark', '--bg-light': 'bg_light',
    '--fg-dim': 'fg_dim', '--accent': 'accent', '--selection': 'selection',
    '--red': 'red', '--green': 'green', '--yellow': 'yellow'
  }).forEach(function (kv) {
    if (COLORS[kv[1]]) root.style.setProperty(kv[0], COLORS[kv[1]]);
  });
  root.dataset.mode = COLORS.mode || 'dark';

  var articleEl = document.getElementById('article');
  var statusEl = document.getElementById('status');
  var BLOCK_TAGS = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1, FIGURE: 1, UL: 1, OL: 1, TABLE: 1 };
  var WIDGETS = '.ai-btn, .ai-badge, .fact-card, .fact-wheel';
  var blocks = [];   // {el, text, summary}
  var active = -1;

  function $(s) { return document.querySelector(s); }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('show', !!msg);
    statusEl.classList.toggle('error', !!isError);
  }

  // ── extract article ─────��───────────────────────────────────────────
  function extract() {
    var parsed = null;
    try {
      var doc = new DOMParser().parseFromString(RAW, 'text/html');
      var base = doc.createElement('base');
      base.href = PAGE_URL || 'about:blank';
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
      parsed = new Readability(doc, { charThreshold: 0 }).parse();
    } catch (e) { parsed = null; }

    var content = parsed && parsed.content;
    if (!content) {
      var d = new DOMParser().parseFromString(RAW, 'text/html');
      content = (d.body ? d.body.innerHTML : '') || '<p>Could not extract an article from this page.</p>';
    }
    articleEl.innerHTML = content;

    if (parsed && parsed.title) {
      var h1 = document.createElement('h1');
      h1.textContent = parsed.title;
      articleEl.insertBefore(h1, articleEl.firstChild);
    }
    if (parsed && parsed.byline) {
      var by = document.createElement('p');
      by.textContent = parsed.byline;
      by.style.color = 'var(--fg-dim)';
      (articleEl.querySelector('h1') || articleEl.firstChild).after(by);
    }
  }

  // Text of a block without the annotation widgets (used as the AI payload).
  function blockText(el) {
    var clone = el.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll(WIDGETS), function (n) { n.remove(); });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── turn the content into addressable blocks ────────────────────────
  function buildBlocks() {
    // Idempotent: strip previous annotation, then re-collect. Re-runnable because
    // the AI summary is inserted as a block above the title *after* first build.
    Array.from(articleEl.querySelectorAll('.ai-btn, .ai-badge')).forEach(function (n) { n.remove(); });
    blocks = [];

    var roots = Array.from(articleEl.children);
    if (roots.length === 1 && !BLOCK_TAGS[roots[0].tagName]) roots = Array.from(roots[0].children);

    var collected = [];
    (function walk(nodes) {
      nodes.forEach(function (el) {
        if (el.nodeType !== 1) return;
        if (el.classList.contains('fact-card') || el.classList.contains('fact-wheel')) return;
        // An already-marked block (incl. .summary-blk) is a block; don't descend
        // into it or its list/table children would become blocks of their own.
        if (el.classList.contains('blk') || BLOCK_TAGS[el.tagName]) collected.push(el);
        else walk(Array.from(el.children));
      });
    })(roots);

    if (!collected.length) collected = Array.from(articleEl.querySelectorAll('p'));

    collected.forEach(function (el, i) {
      var isSummary = el.classList.contains('summary-blk');
      el.classList.add('blk');
      el.dataset.i = i;
      el.tabIndex = 0;
      blocks.push({ el: el, text: blockText(el), summary: isSummary });

      if (!isSummary) {
        var btn = document.createElement('button');
        btn.className = 'ai-btn';
        btn.type = 'button';
        btn.textContent = 'AI?';
        btn.title = 'AI score for this paragraph (←)';
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); markParagraph(i); });
        el.appendChild(btn);

        var badge = document.createElement('span');
        badge.className = 'ai-badge';
        el.appendChild(badge);
      }

      if (!el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('click', function () { setActive(parseInt(el.dataset.i, 10)); });
      }
    });
  }

  // ── focus / paragraph-wise navigation ───────────────────────────────
  function setActive(i) {
    if (focusedWheel != null && focusedWheel !== i) blurWheel();
    if (active >= 0 && blocks[active]) blocks[active].el.classList.remove('active');
    active = i;
    if (i >= 0 && blocks[i]) {
      blocks[i].el.classList.add('active');
      blocks[i].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    $('#btn-focus').classList.toggle('on', document.body.classList.contains('focus-mode'));
  }

  function toggleFocus(force) {
    var on = force === undefined ? !document.body.classList.contains('focus-mode') : force;
    document.body.classList.toggle('focus-mode', on);
    articleEl.classList.toggle('focus', on);
    if (on && active < 0) setActive(0);
    if (!on) setActive(-1);
  }

  function move(d) {
    if (!blocks.length) return;
    blurWheel();
    if (!document.body.classList.contains('focus-mode')) toggleFocus(true);
    var i = active < 0 ? (d > 0 ? 0 : blocks.length - 1) : active + d;
    setActive(Math.max(0, Math.min(blocks.length - 1, i)));
  }

  // ── local AI ────────────────────────────────────────────────────────
  function ai(payload) {
    return fetch('/ai?t=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad response' }; })
        .then(function (data) {
          if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
          return data.result;
        });
    });
  }

  function verdictClass(v) { return v === 'ai' ? 'v-ai' : v === 'mixed' ? 'v-mixed' : 'v-human'; }

  function applyVerdict(i, res) {
    var b = blocks[i];
    if (!b || !b.text) return;
    var el = b.el;
    var v = String(res.verdict || 'human').toLowerCase();
    el.classList.remove('v-human', 'v-mixed', 'v-ai');
    el.classList.add(verdictClass(v), 'marked');
    if (res.reason) el.title = res.reason;
    var badge = el.querySelector('.ai-badge');
    if (badge) {
      badge.textContent = v.toUpperCase() + ' ';
      var pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = typeof res.ai_likelihood === 'number' ? res.ai_likelihood + '%' : '';
      badge.appendChild(pct);
    }
  }

  function markParagraph(i) {
    var b = blocks[i];
    if (!b || !b.text) return;
    var btn = b.el.querySelector('.ai-btn');
    if (btn) { btn.textContent = '…'; btn.classList.add('busy'); btn.disabled = true; }
    setStatus('Asking the local AI about paragraph ' + (i + 1) + '…');
    ai({ mode: 'paragraph', text: b.text }).then(function (res) {
      applyVerdict(i, res);
      setStatus('');
    }).catch(function (e) {
      setStatus('AI error: ' + e.message, true);
      if (btn) { btn.textContent = 'AI?'; btn.classList.remove('busy'); btn.disabled = false; }
    });
  }

  function markAll() {
    var texts = blocks.map(function (b) { return b.text || ''; });
    if (!texts.some(function (t) { return t.length; })) return;
    var btn = $('#btn-markall'), old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    setStatus('Asking the local AI to score ' + texts.length + ' paragraphs…');
    ai({ mode: 'article_marks', paragraphs: texts }).then(function (arr) {
      if (Array.isArray(arr)) {
        arr.forEach(function (item, pos) {
          var i = typeof item.index === 'number' ? item.index : pos;
          if (i >= 0 && i < blocks.length) applyVerdict(i, item);
        });
      }
      setStatus('');
    }).catch(function (e) { setStatus('AI error: ' + e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = old; });
  }

  // The summary becomes a real block (#article's first child, above the title)
  // so paragraph focus reaches it — press ↑ from the headline.
  function renderSummary(res) {
    var existing = articleEl.querySelector('.summary-blk');
    var el = existing || document.createElement('div');
    el.className = 'blk summary-blk';
    el.tabIndex = 0;
    el.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'summary-head';
    var label = document.createElement('span');
    label.textContent = 'AI summary';
    head.appendChild(label);

    var v = String(res.verdict || '').toLowerCase();
    if (v) {
      var badge = document.createElement('span');
      badge.className = 'badge ' + verdictClass(v);
      badge.textContent = v.toUpperCase() +
        (typeof res.ai_likelihood === 'number' ? ' · ' + res.ai_likelihood + '%' : '');
      head.appendChild(badge);
    }

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Remove the summary';
    close.addEventListener('click', function (ev) {
      ev.stopPropagation();
      el.remove();
      buildBlocks();
      setActive(Math.min(active, blocks.length - 1));
    });
    head.appendChild(close);
    el.appendChild(head);

    var ul = document.createElement('ul');
    (res.summary || []).forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    el.appendChild(ul);

    if (res.reason) {
      var r = document.createElement('div');
      r.className = 'reason';
      r.textContent = res.reason;
      el.appendChild(r);
    }

    if (!existing) articleEl.insertBefore(el, articleEl.firstChild);   // above the title
    buildBlocks();                                                     // → block 0
    setActive(0);
  }

  function summarize() {
    var text = blocks.map(function (b) { return b.text; }).join('\n\n');
    if (!text.trim()) return;
    var btn = $('#btn-summary'), old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    setStatus('Asking the local AI for a summary…');
    ai({ mode: 'summary', text: text }).then(function (res) {
      renderSummary(res);
      setStatus('');
    }).catch(function (e) { setStatus('AI error: ' + e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ── fact-check: verdict card LEFT, article "wheel" RIGHT ────────────
  var FACT_CLASS = { supported: 'fact-supported', disputed: 'fact-disputed',
                     unclear: 'fact-unclear', opinion: 'fact-opinion' };
  var facts = {};            // block index -> fact-check result
  var wheels = {};           // block index -> {el, items, index, reel, counter}
  var focusedWheel = null;
  var WHEEL_ITEM_H = 4;      // rem — must match .wheel-item height in reader.css

  function renderFactCard(i, res) {
    var b = blocks[i];
    if (!b) return;
    var card = b.el.querySelector('.fact-card') || document.createElement('div');
    var verdict = String(res.verdict || 'unclear').toLowerCase();
    card.className = 'fact-card ' + (FACT_CLASS[verdict] || 'fact-unclear');
    card.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'fact-head';
    head.textContent = 'Fact-check · ' + verdict.toUpperCase() +
      (typeof res.confidence === 'number' ? ' · ' + res.confidence + '%' : '') +
      (res.outlets && res.outlets.length ? ' · ' + res.outlets.length + ' outlets' : '');
    card.appendChild(head);

    if (res.reason) {
      var r = document.createElement('div');
      r.className = 'fact-reason';
      r.textContent = res.reason;
      card.appendChild(r);
    }
    if (res.query) {
      var q = document.createElement('div');
      q.className = 'fact-query';
      q.textContent = 'search: ' + res.query;
      card.appendChild(q);
    }
    if (!card.parentNode) b.el.appendChild(card);
  }

  function paintWheel(i) {
    var w = wheels[i];
    if (!w) return;
    var n = w.items.length;
    w.index = Math.max(0, Math.min(n - 1, w.index));
    var offset = Math.min(Math.max(w.index - 1, 0), Math.max(n - 3, 0));
    w.reel.style.transform = 'translateY(-' + (offset * WHEEL_ITEM_H) + 'rem)';
    Array.prototype.forEach.call(w.reel.children, function (c, k) {
      c.classList.toggle('cur', k === w.index);
    });
    w.counter.textContent = (w.index + 1) + '/' + n;
  }

  function renderWheel(i) {
    var b = blocks[i], res = facts[i];
    if (!b || !res) return;
    var items = res.headlines || [];
    var old = b.el.querySelector('.fact-wheel');
    if (old) old.remove();
    delete wheels[i];
    if (focusedWheel === i) focusedWheel = null;
    if (!items.length) return;

    var el = document.createElement('div');
    el.className = 'fact-wheel';
    el.tabIndex = 0;

    var head = document.createElement('div');
    head.className = 'wheel-head';
    var label = document.createElement('span');
    label.textContent = 'Supporting articles';
    var counter = document.createElement('span');
    head.appendChild(label); head.appendChild(counter);
    el.appendChild(head);

    var vp = document.createElement('div');
    vp.className = 'wheel-viewport';
    var reel = document.createElement('div');
    reel.className = 'wheel-reel';
    items.forEach(function (h, n) {
      var it = document.createElement('div');
      it.className = 'wheel-item';
      var src = document.createElement('span');
      src.className = 'wo';
      src.textContent = h.source || 'source';
      var hl = document.createElement('span');
      hl.className = 'wh';
      hl.textContent = h.headline || '';
      it.appendChild(src); it.appendChild(hl);
      it.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var w = wheels[i];
        if (!w) return;
        focusedWheel = i;
        w.index = n;
        paintWheel(i);
        wheelOpen();
      });
      reel.appendChild(it);
    });
    vp.appendChild(reel);
    el.appendChild(vp);

    var foot = document.createElement('div');
    foot.className = 'wheel-foot';
    [['▲', -1], ['▼', 1], ['Open ↵', 0]].forEach(function (spec) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = spec[0];
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        focusedWheel = i;
        if (spec[1]) wheelMove(spec[1]); else wheelOpen();
      });
      foot.appendChild(btn);
    });
    el.appendChild(foot);

    el.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      focusedWheel = i;
      wheelMove(ev.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    b.el.appendChild(el);
    wheels[i] = { el: el, items: items, index: 0, reel: reel, counter: counter };
    paintWheel(i);
  }

  function focusWheel(i) {
    var w = wheels[i];
    if (!w) return false;
    Object.keys(wheels).forEach(function (k) { wheels[k].el.classList.remove('focused'); });
    w.el.classList.add('focused');
    try { w.el.focus(); } catch (e) {}
    focusedWheel = i;
    setStatus('Supporting articles ' + (w.index + 1) + '/' + w.items.length +
              ' — ↑/↓ scroll · Enter open · Esc leave');
    return true;
  }

  function blurWheel() {
    if (focusedWheel != null && wheels[focusedWheel]) wheels[focusedWheel].el.classList.remove('focused');
    focusedWheel = null;
  }

  function wheelFocused() { return focusedWheel != null && !!wheels[focusedWheel]; }

  function wheelMove(d) {
    if (!wheelFocused()) return;
    var w = wheels[focusedWheel];
    w.index = (w.index + d + w.items.length) % w.items.length;
    paintWheel(focusedWheel);
    setStatus('Supporting articles ' + (w.index + 1) + '/' + w.items.length);
  }

  function wheelOpen() {
    if (!wheelFocused()) return;
    var w = wheels[focusedWheel];
    var it = w.items[w.index];
    if (!it) return;
    if (it.url) {
      try { window.open(it.url, '_blank'); } catch (e) { location.href = it.url; }
    }
    setStatus('Opened: ' + (it.source || it.url || ''));
  }

  function factCheck(i) {
    var b = blocks[i];
    if (!b || !b.text) return;
    var btn = $('#btn-fact');
    if (btn) btn.disabled = true;
    setStatus('Fact-checking paragraph ' + (i + 1) + ' against other news outlets…');
    ai({ mode: 'factcheck', text: b.text }).then(function (res) {
      facts[i] = res;
      renderFactCard(i, res);
      renderWheel(i);
      setStatus('Fact-check done — → focuses the article wheel');
    }).catch(function (e) {
      setStatus('Fact-check error: ' + e.message, true);
    }).finally(function () { if (btn) btn.disabled = false; });
  }

  function factCheckArticle() {
    var paras = blocks.map(function (b) { return b.text || ''; });
    if (!paras.some(function (t) { return t.length; })) return;
    var btn = $('#btn-fact');
    if (btn) btn.disabled = true;
    setStatus('Fact-checking the whole article against other news outlets…');
    ai({ mode: 'factcheck_article', paragraphs: paras }).then(function (arr) {
      var n = 0;
      (Array.isArray(arr) ? arr : []).forEach(function (item) {
        var idx = typeof item.index === 'number' ? item.index : -1;
        if (idx >= 0 && idx < blocks.length) {
          facts[idx] = item;
          renderFactCard(idx, item);
          n++;
        }
      });
      setStatus('Fact-checked ' + n + ' paragraph(s) of the article');
    }).catch(function (e) {
      setStatus('Fact-check error: ' + e.message, true);
    }).finally(function () { if (btn) btn.disabled = false; });
  }

  // ── remove / restore AI-written paragraphs (double ←) ───────────────
  var removedAI = [];

  function removeAIWritten() {
    var victims = [];
    blocks.forEach(function (b, i) { if (b.el.classList.contains('v-ai')) victims.push(i); });
    if (!victims.length) {
      setStatus('No paragraph marked as AI-written — press ← (or M) to score first', true);
      return;
    }
    victims.forEach(function (i) {
      var el = blocks[i].el;
      removedAI.push({ el: el, next: el.nextSibling });
      el.remove();
    });
    blurWheel();
    buildBlocks();
    setActive(Math.min(active, blocks.length - 1));
    var undo = $('#btn-undo');
    if (undo) undo.hidden = false;
    setStatus('Removed ' + victims.length + ' AI-written paragraph(s)');
  }

  function restoreAI() {
    removedAI.slice().reverse().forEach(function (rec) {
      try { articleEl.insertBefore(rec.el, rec.next); } catch (e) { articleEl.appendChild(rec.el); }
    });
    removedAI = [];
    buildBlocks();
    var undo = $('#btn-undo');
    if (undo) undo.hidden = true;
    setStatus('Restored hidden paragraphs');
  }

  // ── double-tap dispatch (single press vs double press of ← / →) ─────
  var lastTap = {}, pendingTap = {};
  function tap(name, single, double) {
    var now = Date.now();
    if (lastTap[name] && now - lastTap[name] < 450) {
      lastTap[name] = 0;
      if (pendingTap[name]) { clearTimeout(pendingTap[name]); pendingTap[name] = null; }
      double();
      return;
    }
    lastTap[name] = now;
    pendingTap[name] = setTimeout(function () {
      pendingTap[name] = null;
      lastTap[name] = 0;
      single();
    }, 460);
  }

  function currentIndex() {
    if (active < 0) { toggleFocus(true); setActive(0); }
    return active;
  }

  function scoreArrow() {
    tap('left', function () { var i = currentIndex(); if (i >= 0) markParagraph(i); }, removeAIWritten);
  }

  function factArrow() {
    tap('right', function () {
      var i = currentIndex();
      if (i < 0) return;
      if (facts[i]) { if (!focusWheel(i)) factCheck(i); }
      else factCheck(i);
    }, factCheckArticle);
  }

  // ── wiring ──────────────────────────────────────────────────────────
  $('#btn-summary').addEventListener('click', summarize);
  $('#btn-markall').addEventListener('click', markAll);
  $('#btn-focus').addEventListener('click', function () { toggleFocus(); });
  $('#btn-hide').addEventListener('click', function () { document.body.classList.toggle('chrome-hidden'); });
  $('#btn-next').addEventListener('click', function () { if (wheelFocused()) wheelMove(1); else move(1); });
  $('#btn-prev').addEventListener('click', function () { if (wheelFocused()) wheelMove(-1); else move(-1); });
  $('#btn-score').addEventListener('click', scoreArrow);
  $('#btn-fact').addEventListener('click', factArrow);
  var undoBtn = $('#btn-undo');
  if (undoBtn) undoBtn.addEventListener('click', restoreAI);

  var fontSize = 19;
  function bumpFont(delta) {
    fontSize = Math.max(13, Math.min(40, fontSize + delta));
    root.style.setProperty('--font-size', fontSize + 'px');
  }
  $('#btn-fontinc').addEventListener('click', function () { bumpFont(2); });
  $('#btn-fontdec').addEventListener('click', function () { bumpFont(-2); });

  // Expose the actions so qutebrowser keybindings can drive them — page keydown
  // events are consumed by qutebrowser's normal mode, so the page's own
  // shortcuts only fire in insert mode. config.py binds ,n ,N ,e ,c ,o to these
  // (guarded, so they no-op on non-reader pages).
  window.omarchyReader = {
    next: function () { if (wheelFocused()) wheelMove(1); else move(1); },
    prev: function () { if (wheelFocused()) wheelMove(-1); else move(-1); },
    focus: function () { toggleFocus(); },
    mark: scoreArrow,
    score: scoreArrow,
    factcheck: factArrow,
    factcheckall: factCheckArticle,
    removeai: removeAIWritten,
    restoreai: restoreAI,
    wheelnext: function () { if (wheelFocused()) wheelMove(1); },
    wheelprev: function () { if (wheelFocused()) wheelMove(-1); },
    wheelopen: wheelOpen,
    wheelfocus: function () { if (active >= 0) focusWheel(active); },
    markAll: markAll,
    summarize: summarize
  };

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (wheelFocused()) {
      switch (e.key) {
        case 'ArrowDown': case 'j': wheelMove(1); e.preventDefault(); return;
        case 'ArrowUp': case 'k': wheelMove(-1); e.preventDefault(); return;
        case 'Enter': wheelOpen(); e.preventDefault(); return;
        case 'Escape': blurWheel(); e.preventDefault(); return;
      }
    }

    switch (e.key) {
      case 'j': case 'ArrowDown': move(1); e.preventDefault(); break;
      case 'k': case 'ArrowUp': move(-1); e.preventDefault(); break;
      case 'ArrowLeft': scoreArrow(); e.preventDefault(); break;
      case 'ArrowRight': factArrow(); e.preventDefault(); break;
      case 'f': toggleFocus(); break;
      case 'm': scoreArrow(); break;
      case 'M': markAll(); break;
      case 's': summarize(); break;
      case 'Escape': toggleFocus(false); break;
    }
  });

  extract();
  buildBlocks();
  if (blocks.length) setActive(0);
})();

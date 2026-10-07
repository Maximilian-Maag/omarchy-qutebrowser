/* omarchy-qutebrowser reader — distraction-free reading + local-AI provenance/summary.
 *
 * Article extraction: Mozilla Readability (reader/readability.js, Apache-2.0).
 * AI: POST /ai on the loopback reader-server, which runs the local agent
 *     (`hermes -z … --cli`). Nothing leaves the machine.
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
  var blocks = [];   // {el, text}
  var active = -1;

  function $(s) { return document.querySelector(s); }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('show', !!msg);
    statusEl.classList.toggle('error', !!isError);
  }

  // ── extract article ─────────────────────────────────────────────────
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

  // ── turn the content into addressable blocks ────────────────────────
  function buildBlocks() {
    blocks = [];
    var roots = Array.from(articleEl.children);
    if (roots.length === 1 && !BLOCK_TAGS[roots[0].tagName]) roots = Array.from(roots[0].children);

    var collected = [];
    (function walk(nodes) {
      nodes.forEach(function (el) {
        if (el.nodeType !== 1) return;
        if (BLOCK_TAGS[el.tagName]) collected.push(el);
        else walk(Array.from(el.children));
      });
    })(roots);

    if (!collected.length) collected = Array.from(articleEl.querySelectorAll('p'));

    collected.forEach(function (el, i) {
      el.classList.add('blk');
      el.dataset.i = i;
      el.tabIndex = 0;
      var text = (el.innerText || el.textContent || '').trim();
      blocks.push({ el: el, text: text });

      var btn = document.createElement('button');
      btn.className = 'ai-btn';
      btn.type = 'button';
      btn.textContent = 'AI?';
      btn.title = 'Ask the local AI whether this paragraph looks AI-written';
      btn.addEventListener('click', function (ev) { ev.stopPropagation(); markParagraph(i); });
      el.appendChild(btn);

      var badge = document.createElement('span');
      badge.className = 'ai-badge';
      el.appendChild(badge);

      el.addEventListener('click', function () { setActive(i); });
    });
  }

  // ── focus / paragraph-wise navigation ───────────────────────────────
  function setActive(i) {
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

  function renderSummary(res) {
    var panel = $('#summary');
    panel.hidden = false;
    var list = $('#summary-list');
    list.innerHTML = '';
    (res.summary || []).forEach(function (b) {
      var li = document.createElement('li');
      li.textContent = b;
      list.appendChild(li);
    });
    var v = String(res.verdict || '').toLowerCase();
    var sv = $('#summary-verdict');
    sv.className = 'badge ' + (v ? verdictClass(v) : '');
    sv.textContent = v ? (v.toUpperCase() + (typeof res.ai_likelihood === 'number' ? ' · ' + res.ai_likelihood + '%' : '')) : '';
    $('#summary-reason').textContent = res.reason || '';
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

  // ── wiring ──────────────────────────────────────────────────────────
  $('#btn-summary').addEventListener('click', summarize);
  $('#btn-markall').addEventListener('click', markAll);
  $('#btn-focus').addEventListener('click', function () { toggleFocus(); });
  $('#btn-hide').addEventListener('click', function () { document.body.classList.toggle('chrome-hidden'); });
  $('#summary-close').addEventListener('click', function () { $('#summary').hidden = true; });
  $('#btn-next').addEventListener('click', function () { move(1); });
  $('#btn-prev').addEventListener('click', function () { move(-1); });

  var fontSize = 19;
  function bumpFont(delta) {
    fontSize = Math.max(13, Math.min(40, fontSize + delta));
    root.style.setProperty('--font-size', fontSize + 'px');
  }
  $('#btn-fontinc').addEventListener('click', function () { bumpFont(2); });
  $('#btn-fontdec').addEventListener('click', function () { bumpFont(-2); });

  // Expose the actions so qutebrowser keybindings can drive them — page keydown
  // events are consumed by qutebrowser's normal mode, so the page's own j/k/…
  // shortcuts only fire in insert mode. config.py binds ,n/,N/,f/,m/,M/,s to
  // these (guarded, so they no-op on non-reader pages).
  window.omarchyReader = {
    next: function () { move(1); },
    prev: function () { move(-1); },
    focus: function () { toggleFocus(); },
    mark: function () { if (active >= 0) markParagraph(active); },
    markAll: markAll,
    summarize: summarize
  };

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case 'j': case 'ArrowDown': move(1); e.preventDefault(); break;
      case 'k': case 'ArrowUp': move(-1); e.preventDefault(); break;
      case 'f': toggleFocus(); break;
      case 'm': if (active >= 0) markParagraph(active); break;
      case 'M': markAll(); break;
      case 's': summarize(); break;
      case 'Escape': toggleFocus(false); break;
    }
  });

  extract();
  buildBlocks();
  if (blocks.length) setActive(0);
})();

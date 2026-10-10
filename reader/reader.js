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
  var WIDGETS = '.ai-btn, .ai-badge, .fact-card, .fact-wheel, .para-summary';
  var blocks = [];   // {el, text, summary}
  var active = -1;

  // Paragraph identity. `blocks` is REBUILT whenever the DOM changes (the AI
  // summary is inserted as a block above the title, AI-written paragraphs are
  // removed/restored), so an index captured before an awaited AI call can point
  // at a different paragraph afterwards. Everything asynchronous therefore
  // carries the block ELEMENT and re-resolves its index via el.dataset.i (kept
  // current by buildBlocks()).
  function idxOf(el) {
    var i = parseInt(el && el.dataset ? el.dataset.i : NaN, 10);
    return isNaN(i) ? -1 : i;
  }
  function activeEl() { return (active >= 0 && blocks[active]) ? blocks[active].el : null; }
  // Real article paragraphs — the AI summary block is not article content, so it
  // must never be fed back into a summary/fact-check request.
  function articleBlocks() {
    return blocks.filter(function (b) { return !b.summary; });
  }

  function $(s) { return document.querySelector(s); }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('show', !!msg);
    statusEl.classList.toggle('error', !!isError);
  }

  // ── extract article ─────��───────────────────────────────────────────
  // ── embedded media ──────────────────────────────────────────────────
  // Readability drops video/audio/iframes, and the reader serves from a loopback
  // port so relative URLs would resolve against the wrong host. Media is therefore
  // collected from the parsed page first, with absolute URLs, and spliced back into
  // the extracted article next to the text block it followed.
  var MEDIA_SEL = 'video, audio, iframe, embed, object';
  var BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, table';
  var MEDIA_SKIP = /doubleclick|googlesyndication|googleadservices|pagead|taboola|outbrain|adnxs|criteo|adsystem|\/ads?[\/.]/i;

  function mediaAbsUrl(el) {
    // The IDL property resolves against the <base> injected above; the raw
    // attribute would still be relative.
    var url = '';
    try { url = el.src || el.currentSrc || ''; } catch (e) {}
    if (!url) {
      try {
        var child = el.querySelector('source[src], source[data-src]');
        if (child) url = child.src || child.getAttribute('src') || '';
      } catch (e) {}
    }
    if (!url) {
      try { url = el.getAttribute('src') || el.getAttribute('data-src') || ''; } catch (e) {}
    }
    return url ? String(url).trim() : '';
  }

  function collectMedia(doc) {
    var out = [];
    var nodes;
    try { nodes = doc.querySelectorAll(MEDIA_SEL); } catch (e) { return out; }
    var body = doc.body || doc.documentElement;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        var src = mediaAbsUrl(el);
        if (!src || MEDIA_SKIP.test(src)) continue;
        if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue;
        var w = parseInt(el.getAttribute('width') || '0', 10);
        var h = parseInt(el.getAttribute('height') || '0', 10);
        if (w === 1 && h === 1) continue;                       // tracking pixel
        var cls = String(el.className || '');
        if (/(^|[\s_-])(ad|ads|advert|sponsor|promo)([\s_-]|$)/i.test(cls)) continue;

        // How many text blocks precede this element: the reader's article is built
        // from the same block selector, so the count puts the media back in place.
        var before = 0;
        try {
          var bl = doc.querySelectorAll(BLOCK_SEL);
          for (var b = 0; b < bl.length && b < 4000; b++) {
            if (bl[b].compareDocumentPosition
                && (bl[b].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
              before++;
            }
          }
        } catch (e) {}

        var fig = null;
        try { fig = el.closest ? el.closest('figure') : null; } catch (e) {}
        var caption = '';
        try {
          var cap = fig && fig.querySelector('figcaption');
          caption = cap ? (cap.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        } catch (e) {}
        if (!caption) {
          try { caption = String(el.getAttribute('title') || el.getAttribute('aria-label') || '').trim(); } catch (e) {}
        }

        out.push({ tag: el.tagName.toLowerCase(), src: src,
                   poster: (function () { try { return el.poster || ''; } catch (e) { return ''; } })(),
                   type: (function () { try { return el.getAttribute('type') || ''; } catch (e) { return ''; } })(),
                   caption: caption, before: before });
        if (out.length >= 12) break;                            // keep it readable
      } catch (e) {}
    }
    return out;
  }

  function buildMediaEl(m) {
    var block = document.createElement('div');
    block.className = 'media-block';
    var caption = document.createElement('div');
    caption.className = 'media-caption';

    if (m.tag === 'video' || m.tag === 'audio') {
      var media = document.createElement(m.tag);
      media.controls = true;
      media.preload = 'metadata';
      if (m.poster) media.poster = m.poster;
      if (m.tag === 'audio') media.src = m.src;
      else {
        var source = document.createElement('source');
        source.src = m.src;
        if (m.type) source.type = m.type;
        media.appendChild(source);
      }
      block.appendChild(media);
      caption.textContent = m.caption || (m.tag === 'audio' ? 'Audio' : 'Video');
    } else {
      var frame = document.createElement('iframe');
      frame.className = 'media-embed';
      frame.src = m.src;
      frame.loading = 'lazy';
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      block.appendChild(frame);
      caption.appendChild(function () {
        var a = document.createElement('a');
        a.href = m.src;
        a.textContent = m.caption || ('Embedded ' + m.tag);
        return a;
      }());
    }
    block.appendChild(caption);
    return block;
  }

  function spliceMedia(items) {
    var blocks = Array.prototype.slice.call(articleEl.querySelectorAll(BLOCK_SEL));
    // Insert from the last one backwards so an insertion cannot shift the position
    // a later (earlier in the document) element is about to use.
    var ordered = items.slice().sort(function (a, b) { return (a.before || 0) - (b.before || 0); });
    // Forward, not backwards. `ref` is an ELEMENT, so inserting into the DOM cannot
    // shift the reference a later item uses — the backwards loop only existed to dodge
    // index shifts, and it reversed any two items sharing an anchor (two players after
    // the same paragraph came out swapped).
    for (var i = 0; i < ordered.length; i++) {
      var el = buildMediaEl(ordered[i]);
      var ref = blocks[ordered[i].before] || null;
      if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref);
      else articleEl.appendChild(el);
    }
    return ordered.length;
  }

  function extract() {
    var parsed = null, media = [];
    try {
      var doc = new DOMParser().parseFromString(RAW, 'text/html');
      var base = doc.createElement('base');
      base.href = PAGE_URL || 'about:blank';
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
      media = collectMedia(doc);          // before Readability drops them
      parsed = new Readability(doc, { charThreshold: 0 }).parse();
    } catch (e) { parsed = null; }

    var content = parsed && parsed.content;
    if (!content) {
      var d = new DOMParser().parseFromString(RAW, 'text/html');
      content = (d.body ? d.body.innerHTML : '') || '<p>Could not extract an article from this page.</p>';
    }
    articleEl.innerHTML = content;

    // Readability keeps <video> itself (with relative URLs, and without our ad /
    // 1x1 filtering), which would double every player once we splice our own copies
    // in — so drop whatever it kept and let the collected version stand.
    try {
      Array.prototype.slice.call(
        articleEl.querySelectorAll('video, audio, iframe, embed, object')
      ).forEach(function (el) {
        var fig = el.closest ? el.closest('figure') : null;
        if (fig && !fig.querySelector('img, picture')) fig.remove();
        else el.remove();
      });
    } catch (e) {}

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
    if (media.length) {
      var put = spliceMedia(media);
      setStatus(put + ' embedded media element(s) kept');
      setTimeout(function () { setStatus(''); }, 2600);
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
    var prevActive = (active >= 0 && blocks[active]) ? blocks[active].el : null;
    Array.from(articleEl.querySelectorAll('.ai-btn, .ai-badge')).forEach(function (n) { n.remove(); });
    // Elements are re-collected below, so drop stale highlight/annotation state —
    // otherwise a rebuild (e.g. after inserting the summary) leaves TWO blocks lit.
    Array.from(articleEl.querySelectorAll('.blk.active')).forEach(function (n) { n.classList.remove('active'); });
    blocks = [];

    var roots = Array.from(articleEl.children);
    if (roots.length === 1 && !BLOCK_TAGS[roots[0].tagName]) roots = Array.from(roots[0].children);

    var collected = [];
    (function walk(nodes) {
      nodes.forEach(function (el) {
        if (el.nodeType !== 1) return;
        if (el.classList.contains('fact-card') || el.classList.contains('fact-wheel') ||
            el.classList.contains('para-summary')) return;
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
        // Pass the ELEMENT, not the index: markParagraph() expects one (it calls
        // blockText/idxOf on it), so `markParagraph(i)` made this button a silent
        // no-op — text came back empty and the function returned before doing anything.
        // The element is also the durable handle: idxOf() re-resolves the index.
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); markParagraph(el); });
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

    // Re-light the SAME paragraph: indices shift when the summary is inserted or
    // paragraphs are removed, so follow the element rather than the old index.
    active = -1;
    if (prevActive) {
      for (var j = 0; j < blocks.length; j++) {
        if (blocks[j].el === prevActive) {
          active = j;
          blocks[j].el.classList.add('active');
          break;
        }
      }
    }
    // Re-write the verdict badge text for paragraphs that were already scored: the
    // rebuild above strips and re-creates the badges, so without this the "%"
    // reading is lost whenever the article is rebuilt (e.g. after a removal).
    blocks.forEach(function (b) {
      var key = paraKey(b.el);
      var mark = pState.marks[key];
      if (mark && b.el.classList.contains('marked')) applyVerdict(b.el, mark);
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

  // ── persistence ──────────────────────────────────────────────────────
  // Annotations (scores, verdicts, summaries, removed paragraphs) and the reading
  // position are stored on the server, keyed by the article URL: the reader is
  // served from a random loopback port, so localStorage would be a fresh origin
  // every run, and a reload used to lose all of it.
  var restoring = true;   // no saves until restore finishes, or a fresh load would
                          // overwrite the stored state with an empty one
  var pState = { v: 1, marks: {}, paras: {}, facts: {}, removed: [], summary: null, pos: null };
  var saveTimer = null;

  function h32(str) {                       // FNV-1a — stable per paragraph text
    var h = 0x811c9dc5, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function paraKey(el) {
    return el ? h32((blockText(el) || '').slice(0, 4000)) : '';
  }

  // The paragraph to resume at is the one the reader is looking at — the lowest
  // block still at/above the middle of the viewport — not merely the focused one.
  function visibleKey() {
    var best = null, bestTop = -Infinity;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].summary) continue;                        // resume at real prose
      var r = blocks[i].el.getBoundingClientRect();
      if (r.bottom < 40) continue;                            // scrolled past
      if (r.top > window.innerHeight * 0.5) continue;         // below the fold
      if (r.top > bestTop) { bestTop = r.top; best = blocks[i].el; }
    }
    if (best) return paraKey(best);
    return activeEl() ? paraKey(activeEl()) : pState.pos;
  }

  var lastSent = '';
  function stateSignature() {
    return JSON.stringify([pState.marks, pState.paras, pState.facts, pState.removed,
                           pState.summary ? 1 : 0, visibleKey()]);
  }

  function saveState(immediate) {
    if (restoring || !PAGE_URL) return;
    clearTimeout(saveTimer);
    if (stateSignature() === lastSent) return;        // nothing new to write
    var send = function () {
      var sig = stateSignature();
      if (sig === lastSent) return;
      // Build the payload HERE, not when the debounce was scheduled: capturing it up
      // front meant a scroll during the 900 ms wait was never persisted, so you resumed
      // at the pre-scroll position.
      var payload = JSON.stringify({
        url: PAGE_URL,
        state: {
          v: 1, marks: pState.marks, paras: pState.paras, facts: pState.facts,
          removed: pState.removed, summary: pState.summary,
          pos: visibleKey(),
          scroll: Math.round(window.scrollY || 0)
        }
      });
      try {
        // A beacon is delivered more reliably than fetch() when the page is going
        // away — otherwise the unload save races the next load's read and can
        // overwrite the state with an older one.
        // lastSent only advances once the write has actually been accepted — otherwise a
        // dropped beacon counted as delivered and was never retried.
        if (navigator.sendBeacon) {
          if (navigator.sendBeacon('/state?t=' + encodeURIComponent(TOKEN),
                                   new Blob([payload], { type: 'application/json' }))) {
            lastSent = sig;
          }
          return;
        }
        fetch('/state?t=' + encodeURIComponent(TOKEN), {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }).then(function (resp) { if (resp && resp.ok) lastSent = sig; })
          .catch(function () {});
      } catch (e) {}
    };
    if (immediate) send(); else saveTimer = setTimeout(send, 900);
  }

  function restoreState() {
    if (!PAGE_URL) { restoring = false; return; }
    restoring = true;
    fetch('/state?t=' + encodeURIComponent(TOKEN) + '&url=' + encodeURIComponent(PAGE_URL))
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s || !s.v) { restoring = false; return; }
        ['marks', 'paras', 'facts', 'removed'].forEach(function (k) {
          if (s[k] && typeof s[k] === 'object') pState[k] = s[k];
        });
        pState.summary = s.summary || null;
        var applied = 0;
        blocks.slice().forEach(function (b) {
          var k = paraKey(b.el);
          if (!k) return;
          if (pState.marks[k]) { applyVerdict(b.el, pState.marks[k]); applied++; }
          if (pState.paras[k]) renderParaSummary(b.el, pState.paras[k]);
          if (pState.facts[k]) {
            facts.set(b.el, pState.facts[k]);
            renderFactCard(b.el, pState.facts[k]);
            renderWheel(b.el, pState.facts[k]);
          }
        });
        if (pState.summary) renderSummary(pState.summary);
        var victims = [];
        blocks.slice().forEach(function (b) {
          if (!b.summary && b.el && pState.removed.indexOf(paraKey(b.el)) !== -1) victims.push(b.el);
        });
        if (victims.length) applyRemoval(victims, true);
        var landed = false;
        if (s.pos) {
          for (var i = 0; i < blocks.length; i++) {
            if (paraKey(blocks[i].el) === s.pos) { setActive(i); landed = true; break; }
          }
        }
        if (!landed && s.scroll) window.scrollTo(0, s.scroll);
        restoring = false;
        if (applied || victims.length || pState.summary) {
          setStatus('Restored your previous annotations and position');
          setTimeout(function () { setStatus(''); }, 2600);
        }
      })
      .catch(function () { restoring = false; });
  }

  function verdictClass(v) { return v === 'ai' ? 'v-ai' : v === 'mixed' ? 'v-mixed' : 'v-human'; }

  function applyVerdict(el, res) {
    if (!el) return;
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
    pState.marks[paraKey(el)] = { verdict: v, ai_likelihood: res.ai_likelihood, reason: res.reason };
    saveState();
  }

  function markParagraph(el) {
    var text = el ? blockText(el) : '';
    if (!text) return;
    var i = idxOf(el);
    var btn = el.querySelector('.ai-btn');
    if (btn) { btn.textContent = '…'; btn.classList.add('busy'); btn.disabled = true; }
    setStatus('Asking the local AI about paragraph ' + (i + 1) + '…');
    ai({ mode: 'paragraph', text: text }).then(function (res) {
      applyVerdict(el, res);
      setStatus('');
    }).catch(function (e) {
      setStatus('AI error: ' + e.message, true);
      if (btn) { btn.textContent = 'AI?'; btn.classList.remove('busy'); btn.disabled = false; }
    });
  }

  function markAll() {
    var targets = articleBlocks();
    var texts = targets.map(function (b) { return b.text || ''; });
    if (!texts.some(function (t) { return t.length; })) return;
    var btn = $('#btn-markall'), old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    setStatus('Asking the local AI to score ' + texts.length + ' paragraphs…');
    ai({ mode: 'article_marks', paragraphs: texts }).then(function (arr) {
      if (Array.isArray(arr)) {
        arr.forEach(function (item, pos) {
          var k = typeof item.index === 'number' ? item.index : pos;
          if (k >= 0 && k < targets.length) applyVerdict(targets[k].el, item);
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
      // Clearing the card is not enough: renderSummary persisted it, so restoreState
      // brought it straight back on the next load. Dismissing has to be saved too.
      pState.summary = null;
      saveState();
      buildBlocks();
      setActive(Math.min(active, blocks.length - 1));
    });
    head.appendChild(close);
    el.appendChild(head);

    // Advertorial / paid-coverage warning. Shown straight under the header, above
    // the bullets, because a reader skimming the summary should not miss it.
    var promo = res.promotional || {};
    var pScore = typeof promo.score === 'number' ? promo.score : 0;
    var pKind = String(promo.kind || '').trim();
    if (pScore >= 40 && pKind.toLowerCase() !== 'none') {
      var warn = document.createElement('div');
      warn.className = 'promo-warning' + (pScore >= 70 ? ' strong' : '');
      var wt = document.createElement('div');
      wt.className = 'pw-title';
      wt.textContent = pScore >= 70
        ? '⚠ Probably paid or promotional content'
        : '⚠ Some commercial-marketing signals';
      warn.appendChild(wt);
      var ws = document.createElement('div');
      ws.className = 'pw-sub';
      ws.textContent = pKind + ' · ' + pScore + '%' +
        (promo.evidence ? ' — ' + promo.evidence : '');
      warn.appendChild(ws);
      el.appendChild(warn);
    }

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

    // This rebuild used to end with setActive(0) — and the summary card IS block 0, so
    // the reader was thrown onto the summary. Two narrower fixes were wrong: the card is
    // rendered on RESTORE too (see the `pState.summary` branch above), so keying off
    // "the card already existed in the DOM" misses exactly the fact-check → reload case
    // that was reported. A rebuild never steals focus: keep the active paragraph, found
    // by TEXT key because inserting the card shifts every index. Only when nothing is
    // active does the card take focus.
    var keepKey = (active >= 0 && blocks[active]) ? paraKey(blocks[active]) : null;
    if (!existing) articleEl.insertBefore(el, articleEl.firstChild);   // above the title
    buildBlocks();
    pState.summary = res;
    saveState();
    if (keepKey) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (paraKey(blocks[bi]) === keepKey) { setActive(bi); return; }
      }
    }
    if (active < 0) setActive(0);
  }

  function summarize() {
    // Only the article itself — feeding a previous AI summary back into a new
    // summary (or fact-check) would contaminate it.
    var text = articleBlocks().map(function (b) { return b.text; }).join('\n\n');
    if (!text.trim()) return;
    var btn = $('#btn-summary'), old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    setStatus('Asking the local AI for a summary…');
    ai({ mode: 'summary', text: text }).then(function (res) {
      renderSummary(res);
      var p = res.promotional || {};
      setStatus(typeof p.score === 'number' && p.score >= 70
        ? '⚠ Summary ready — this article looks like paid/promotional content'
        : '');
    }).catch(function (e) { setStatus('AI error: ' + e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ── paragraph summary (Ctrl+↑) ──────────────────────────────────────
  function renderParaSummary(el, res) {
    if (!el) return;
    var old = el.querySelector('.para-summary');
    if (old) old.remove();
    var card = document.createElement('div');
    card.className = 'para-summary';

    var head = document.createElement('div');
    head.className = 'ps-head';
    head.textContent = 'Paragraph ' + (idxOf(el) + 1) + ' · AI summary';
    card.appendChild(head);

    // one bullet per paragraph: render the single sentence as one line
    var lines = res.summary || [];
    if (typeof lines === 'string') lines = [lines];
    if (lines.length === 1) {
      var p = document.createElement('div');
      p.className = 'ps-line';
      p.textContent = lines[0];
      card.appendChild(p);
    } else {
      var ul = document.createElement('ul');
      lines.forEach(function (t) {
        var li = document.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    if (res.reason) {
      var r = document.createElement('div');
      r.className = 'ps-reason';
      r.textContent = res.reason;
      card.appendChild(r);
    }
    el.appendChild(card);
    pState.paras[paraKey(el)] = res;
    saveState();
  }

  function summarizeParagraph(el) {
    var text = el ? blockText(el) : '';
    if (!text) return;
    var i = idxOf(el);
    setStatus('Asking the local AI to summarise paragraph ' + (i + 1) + '…');
    ai({ mode: 'summary_para', text: text }).then(function (res) {
      renderParaSummary(el, res);
      setStatus('Paragraph ' + (i + 1) + ' summarised');
    }).catch(function (e) {
      setStatus('AI error: ' + e.message, true);
    });
  }

  // ── fact-check: verdict card LEFT, article "wheel" RIGHT ────────────
  var FACT_CLASS = { supported: 'fact-supported', disputed: 'fact-disputed',
                     unclear: 'fact-unclear', opinion: 'fact-opinion' };
  // Keyed by the block ELEMENT, not by index: a rebuild (summary inserted,
  // AI-written paragraphs removed) shifts indices and would otherwise attach a
  // paragraph's verdict to the wrong paragraph. A WeakMap also lets removed
  // paragraphs be collected.
  var facts = new WeakMap();     // block el -> fact-check result
  var wheels = new WeakMap();    // block el -> {el, items, index, reel, counter}
  var focusedWheel = null;       // the wheel OBJECT currently focused (or null)
  var WHEEL_ITEM_H = 4;          // rem — must match .wheel-item height in reader.css

  function renderFactCard(el, res) {
    if (!el) return;
    var verdict = String(res.verdict || 'unclear').toLowerCase();
    var card = el.querySelector('.fact-card') || document.createElement('div');
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
    if (!card.parentNode) el.appendChild(card);
    pState.facts[paraKey(el)] = res;
    saveState();
  }

  function paintWheel(w) {
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

  function renderWheel(el, res) {
    if (!el || !res) return;
    var items = res.headlines || [];
    var old = el.querySelector('.fact-wheel');
    if (old) {
      if (focusedWheel && focusedWheel.el === old) focusedWheel = null;
      old.remove();
    }
    wheels.delete(el);
    if (!items.length) return;

    var wheelEl = document.createElement('div');
    wheelEl.className = 'fact-wheel';
    wheelEl.tabIndex = 0;

    var head = document.createElement('div');
    head.className = 'wheel-head';
    var label = document.createElement('span');
    label.textContent = 'Supporting articles';
    var counter = document.createElement('span');
    head.appendChild(label); head.appendChild(counter);
    wheelEl.appendChild(head);

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
        var w = wheels.get(el);
        if (!w) return;
        focusWheel(w);
        w.index = n;
        paintWheel(w);
        wheelOpen();
      });
      reel.appendChild(it);
    });
    vp.appendChild(reel);
    wheelEl.appendChild(vp);

    var foot = document.createElement('div');
    foot.className = 'wheel-foot';
    [['▲', -1], ['▼', 1], ['Open ↵', 0]].forEach(function (spec) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = spec[0];
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var w = wheels.get(el);
        if (!w) return;
        focusWheel(w);
        if (spec[1]) wheelMove(spec[1]); else wheelOpen();
      });
      foot.appendChild(btn);
    });
    wheelEl.appendChild(foot);

    wheelEl.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var w = wheels.get(el);
      if (!w) return;
      focusWheel(w);
      wheelMove(ev.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    el.appendChild(wheelEl);
    var wheel = { el: wheelEl, items: items, index: 0, reel: reel, counter: counter };
    wheels.set(el, wheel);
    paintWheel(wheel);
  }

  function focusWheel(w) {
    if (!w) return false;
    blurWheel();
    w.el.classList.add('focused');
    try { w.el.focus(); } catch (e) { /* focus is best-effort */ }
    focusedWheel = w;
    setStatus('Supporting articles ' + (w.index + 1) + '/' + w.items.length +
              ' — ↑/↓ scroll · Enter open · Esc leave');
    return true;
  }

  function blurWheel() {
    Array.prototype.forEach.call(articleEl.querySelectorAll('.fact-wheel.focused'),
                                function (n) { n.classList.remove('focused'); });
    focusedWheel = null;
  }

  function wheelFocused() { return focusedWheel != null && focusedWheel.el.isConnected; }

  function wheelMove(d) {
    if (!wheelFocused()) return;
    var w = focusedWheel;
    w.index = (w.index + d + w.items.length) % w.items.length;
    paintWheel(w);
    setStatus('Supporting articles ' + (w.index + 1) + '/' + w.items.length);
  }

  function wheelOpen() {
    if (!wheelFocused()) return;
    var w = focusedWheel;
    var it = w.items[w.index];
    if (!it) return;
    if (it.url) {
      try { window.open(it.url, '_blank'); } catch (e) { location.href = it.url; }
    }
    setStatus('Opened: ' + (it.source || it.url || ''));
  }

  function factCheck(el) {
    var text = el ? blockText(el) : '';
    if (!text) return;
    var i = idxOf(el);
    var btn = $('#btn-fact');
    if (btn) btn.disabled = true;
    setStatus('Fact-checking paragraph ' + (i + 1) + ' against other news outlets…');
    ai({ mode: 'factcheck', text: text }).then(function (res) {
      facts.set(el, res);
      renderFactCard(el, res);
      renderWheel(el, res);
      setStatus('Fact-check done — → focuses the article wheel');
    }).catch(function (e) {
      setStatus('Fact-check error: ' + e.message, true);
    }).finally(function () { if (btn) btn.disabled = false; });
  }

  function factCheckArticle() {
    var targets = articleBlocks();
    var paras = targets.map(function (b) { return b.text || ''; });
    if (!paras.some(function (t) { return t.length; })) return;
    var btn = $('#btn-fact');
    if (btn) btn.disabled = true;
    setStatus('Fact-checking the whole article against other news outlets…');
    ai({ mode: 'factcheck_article', paragraphs: paras }).then(function (arr) {
      var n = 0;
      (Array.isArray(arr) ? arr : []).forEach(function (item) {
        var k = typeof item.index === 'number' ? item.index : -1;
        if (k >= 0 && k < targets.length) {
          facts.set(targets[k].el, item);
          renderFactCard(targets[k].el, item);
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

  // Shared by the ←← action and by restore, so a reload brings back exactly the
  // paragraphs that were hidden (matched by paragraph text, not by index).
  function applyRemoval(victims, silent) {
    var keys = victims.map(function (el) { return paraKey(el); });   // before detaching
    removedAI = victims.map(function (el) { return { el: el, next: el.nextSibling }; });
    removedAI.forEach(function (rec) { try { rec.el.remove(); } catch (e) {} });
    blurWheel();
    buildBlocks();
    setActive(active < 0 ? 0 : Math.min(active, blocks.length - 1));
    var undo = $('#btn-undo');
    if (undo) undo.hidden = false;
    pState.removed = keys;
    if (!silent) setStatus('Removed ' + victims.length + ' AI-written paragraph(s)');
    saveState(true);
  }

  function removeAIWritten() {
    var victims = [];
    blocks.forEach(function (b) { if (b.el.classList.contains('v-ai')) victims.push(b.el); });
    if (!victims.length) {
      setStatus('No paragraph marked as AI-written — press ← (or M) to score first', true);
      return;
    }
    applyRemoval(victims, false);
  }

  function restoreAI() {
    removedAI.slice().reverse().forEach(function (rec) {
      try { articleEl.insertBefore(rec.el, rec.next); } catch (e) { articleEl.appendChild(rec.el); }
    });
    removedAI = [];
    buildBlocks();
    pState.removed = [];
    var undo = $('#btn-undo');
    if (undo) undo.hidden = true;
    setStatus('Restored hidden paragraphs');
    saveState(true);
  }

  // ── double-tap dispatch (single press vs double press of ← / →) ─────
  var lastTap = {}, pendingTap = {};
  function tap(name, single, double, win) {
    win = win || 460;
    var now = Date.now();
    if (lastTap[name] && now - lastTap[name] < Math.min(win, 450)) {
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
    }, win);
  }

  function ensureActive() {
    if (active < 0) { toggleFocus(true); setActive(0); }
    return activeEl();
  }

  function scoreArrow() {
    // While the supporting-article wheel is focused, ← goes back to the paragraph.
    if (wheelFocused()) {
      blurWheel();
      setStatus('Paragraph focus' + (active >= 0 ? ' — paragraph ' + (active + 1) : ''));
      return;
    }
    tap('left', function () { var el = ensureActive(); if (el) markParagraph(el); }, removeAIWritten);
  }

  function factArrow() {
    tap('right', function () {
      var el = ensureActive();
      if (!el) return;
      if (facts.get(el)) { if (!focusWheel(wheels.get(el))) factCheck(el); }
      else factCheck(el);
    }, factCheckArticle);
  }

  // ↑ — previous paragraph, or the whole-article summary on the FIRST paragraph
  // (there is nowhere above to go). Ctrl+↑ summarises just this paragraph, so ↑
  // itself stays instant (no double-press delay).
  function upOnce() {
    var i = active < 0 ? 0 : active;
    if (i <= 0) summarize(); else move(-1);
  }

  function summarizeActiveParagraph() {
    var el = ensureActive();
    if (el) summarizeParagraph(el);
  }

  // ── wiring ──────────────────────────────────────────────────────────
  $('#btn-summary').addEventListener('click', summarize);
  $('#btn-markall').addEventListener('click', markAll);
  $('#btn-focus').addEventListener('click', function () { toggleFocus(); });
  $('#btn-hide').addEventListener('click', function () { document.body.classList.toggle('chrome-hidden'); });
  $('#btn-next').addEventListener('click', function () { if (wheelFocused()) wheelMove(1); else move(1); });
  $('#btn-prev').addEventListener('click', function () { if (wheelFocused()) wheelMove(-1); else upOnce(); });
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
    prev: function () { if (wheelFocused()) wheelMove(-1); else upOnce(); },
    summarypara: summarizeActiveParagraph,
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
    wheelfocus: function () { var el = activeEl(); if (el) focusWheel(wheels.get(el)); },
    markAll: markAll,
    summarize: summarize
  };

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;

    // Ctrl+↑ summarises the current paragraph
    if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'k')) {
      e.preventDefault();
      summarizeActiveParagraph();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (wheelFocused()) {
      switch (e.key) {
        case 'ArrowDown': case 'j': wheelMove(1); e.preventDefault(); return;
        case 'ArrowUp': case 'k': wheelMove(-1); e.preventDefault(); return;
        case 'ArrowLeft': scoreArrow(); e.preventDefault(); return;   // back to the paragraph
        case 'Enter': wheelOpen(); e.preventDefault(); return;
        case 'Escape': blurWheel(); e.preventDefault(); return;
      }
    }

    switch (e.key) {
      case 'j': case 'ArrowDown': move(1); e.preventDefault(); break;
      case 'k': case 'ArrowUp': upOnce(); e.preventDefault(); break;
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

  // Bring back whatever was saved for this article, and persist the position when
  // the user scrolls away or leaves the page.
  restoreState();
  var posTimer = null;
  window.addEventListener('scroll', function () {
    if (restoring) return;
    clearTimeout(posTimer);
    posTimer = setTimeout(function () { saveState(); }, 1500);
  }, { passive: true });
  window.addEventListener('pagehide', function () { saveState(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveState(true);
  });
})();

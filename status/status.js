/* Article status page — metrics, framing, publisher, citation.
 * Everything is computed here from the stored page; only /publisher, /coverage and
 * /framing talk to the local server (which does the network + model work). */
(function () {
  'use strict';

  var TOKEN = window.TOKEN || '';
  var COLORS = window.COLORS || {};
  var CITE = window.CITE || {};
  var ARTICLE_HTML = window.ARTICLE_HTML || '';
  var PAGE_URL = document.body.dataset.url || '';
  var LEAN_COLORS = {
    left: 'var(--left)', 'lean-left': 'var(--lean-left)', center: 'var(--center)',
    'lean-right': 'var(--lean-right)', right: 'var(--right)', state: 'var(--state)',
    unknown: 'var(--line)'
  };
  var LEAN_ORDER = ['left', 'lean-left', 'center', 'lean-right', 'right'];
  var FUNDING_COLORS = {
    advertising: '#e0a07e', subscriptions: '#7dcf8a', 'licence-fee': '#7ecfd0',
    state: '#a978d0', donations: '#6fb3ff', membership: '#9ad0e0',
    underwriting: '#cbd07e', foundations: '#d0a0a0', terminals: '#8f8f8f',
    'cable fees': '#b0b0b0'
  };
  var CUE_RE = /(slams|slammed|blasts|blasted|chaos|disaster|shocking|bombshell|radical|extreme|so-called|crisis|scandal|threat|surge|plunge|devastating|outrage|meltdown|stunning|erupts|skandal|katastrophe|schock|radikal|extrem|umstritten|desaster|hammerhart|wut|triumph|wirbel)/gi;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function applyColors() {
    var root = document.documentElement.style;
    Object.keys(COLORS || {}).forEach(function (k) {
      if (COLORS[k]) root.setProperty('--' + k.replace(/_/g, '-'), COLORS[k]);
    });
  }
  function toast(text) {
    var el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 1800);
  }
  function copy(text, label) {
    var done = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { done = false; }
    if (done) { toast((label || 'copied') + ' copied'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast((label || 'copied') + ' copied'); },
                                               function () { toast('copy blocked — select the text'); });
      return;
    }
    toast('copy blocked — select the text');
  }
  function api(path, params, method, body) {
    var qs = Object.keys(params || {}).filter(function (k) { return params[k]; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
    qs.push('t=' + encodeURIComponent(TOKEN));
    var url = path + '?' + qs.join('&');
    var opts = { method: method || 'GET' };
    if (body) { opts.method = 'POST'; opts.body = body; }
    return fetch(url, opts).then(function (r) { return r.json(); });
  }

  /* ── metrics ─────────────────────────────────────────────────────────── */
  function metricsOf(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var body = doc.body || doc.documentElement;
    var text = (body ? body.textContent : '').replace(/\s+/g, ' ').trim();
    var words = text ? text.split(/\s+/).length : 0;
    var paras = [].slice.call(doc.querySelectorAll('p'))
      .map(function (p) { return (p.textContent || '').trim(); })
      .filter(function (t) { return t.length > 40; });
    var h1 = doc.querySelector('h1');
    var headline = ((h1 && h1.textContent) || CITE.title || '').trim();
    var marks = (text.match(/[\u201e\u201c\u201d\u00ab\u00bb]/g) || []).length;
    var straight = (text.match(/"/g) || []).length;
    var quotes = Math.floor((marks + straight) / 2);
    var digits = (text.match(/\b\d[\d.,]*\s?(%|percent|Prozent|Millionen|million|Milliarden|billion|Euro|euros|USD|Dollar)?\b/gi) || []).length;
    var cues = {};
    (headline + ' ' + paras.slice(0, 2).join(' ')).replace(CUE_RE, function (w) {
      var k = w.toLowerCase();
      cues[k] = (cues[k] || 0) + 1;
      return w;
    });
    return {
      words: words,
      paras: paras.length,
      sentences: text.split(/[.!?\u2026]\s+/).filter(function (s) { return s.trim().length > 3; }).length,
      readingMin: Math.max(1, Math.round(words / 220)),
      quotes: quotes,
      digits: digits,
      links: doc.querySelectorAll('a[href^="http"]').length,
      images: doc.querySelectorAll('img').length,
      named: (text.match(/\b(said|says|told|according to|reported|confirmed|announced|sagte|sagt|erkl\u00e4rte|mitteilte|laut|best\u00e4tigte)\b/gi) || []).length,
      anon: (text.match(/\b(anonymous|unnamed|insider|a source|sources said|not named|on condition|wollte nicht genannt|anonym|auf Anfrage|auf Nachfrage)\b/gi) || []).length,
      headlineWords: headline ? headline.split(/\s+/).length : 0,
      headlineQuestion: /\?\s*$/.test(headline),
      cues: Object.keys(cues).sort(function (a, b) { return cues[b] - cues[a]; }).slice(0, 8),
      cueCount: Object.keys(cues).reduce(function (n, k) { return n + cues[k]; }, 0)
    };
  }

  function barsSvg(rows, unit) {
    var w = 640, rowH = 26, h = rows.length * rowH + 8, max = 1;
    rows.forEach(function (r) { max = Math.max(max, r.value); });
    var out = '';
    rows.forEach(function (r, i) {
      var y = i * rowH + 4, bw = Math.max(2, Math.round((r.value / max) * (w - 240)));
      out += '<text x="0" y="' + (y + 15) + '" fill="currentColor" font-size="12">' + esc(r.label) + '</text>' +
             '<rect x="150" y="' + y + '" width="' + bw + '" height="16" rx="4" fill="' + (r.color || 'var(--accent)') + '" opacity="0.85"/>' +
             '<text x="' + (156 + bw) + '" y="' + (y + 13) + '" fill="currentColor" font-size="12" opacity="0.75">' +
             esc(r.value + (unit || '')) + '</text>';
    });
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>';
  }

  function spectrumSvg(profile, balance) {
    var w = 640, h = 120, colW = w / 5;
    var out = '';
    LEAN_ORDER.forEach(function (lean, i) {
      var x = i * colW, count = (balance && balance[lean]) || 0;
      var active = profile && profile.lean === lean;
      out += '<rect x="' + (x + 6) + '" y="42" width="' + (colW - 12) + '" height="34" rx="6" fill="' +
             LEAN_COLORS[lean] + '" opacity="' + (active ? 0.85 : 0.22) + '"/>';
      out += '<text x="' + (x + colW / 2) + '" y="64" text-anchor="middle" font-size="11" fill="currentColor">' +
             esc(lean.replace('-', ' ')) + '</text>';
      if (count) {
        out += '<text x="' + (x + colW / 2) + '" y="94" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">' +
               count + ' outlet' + (count === 1 ? '' : 's') + '</text>';
      }
      if (active) {
        out += '<polygon points="' + (x + colW / 2 - 7) + ',36 ' + (x + colW / 2 + 7) + ',36 ' +
               (x + colW / 2) + ',24" fill="' + LEAN_COLORS[lean] + '"/>' +
               '<text x="' + (x + colW / 2) + '" y="18" text-anchor="middle" font-size="11" fill="currentColor">this outlet</text>';
      }
    });
    if (profile && profile.lean === 'state') {
      out += '<text x="0" y="112" font-size="11" fill="var(--state)">state-funded — off the left/right axis</text>';
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>';
  }

  function factualSvg(factual) {
    var w = 640, h = 54, seg = ['low', 'mixed', 'high'], labels = { low: 'low', mixed: 'mixed', high: 'high' };
    var out = '';
    seg.forEach(function (s, i) {
      var x = i * (w / 3), active = factual === s;
      out += '<rect x="' + (x + 6) + '" y="6" width="' + (w / 3 - 12) + '" height="26" rx="6" fill="var(--' +
             (s === 'high' ? 'ok' : s === 'mixed' ? 'warn' : 'bad') + ')" opacity="' + (active ? 0.85 : 0.18) + '"/>' +
             '<text x="' + (x + w / 6) + '" y="24" text-anchor="middle" font-size="12" fill="currentColor">' +
             esc(labels[s]) + '</text>';
    });
    out += '<text x="0" y="48" font-size="11" fill="currentColor" opacity="0.7">' +
           (factual ? 'rated "' + esc(factual) + '" by the curated dataset' : 'no factual rating on file') + '</text>';
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>';
  }

  function fundingSvg(kinds) {
    if (!kinds || !kinds.length) return '<p class="muted">funding model not on file</p>';
    var w = 640, h = 66, x = 0;
    var out = '', legend = '<div class="legend">';
    kinds.forEach(function (k, i) {
      var seg = (w / kinds.length) - 4;
      out += '<rect x="' + x + '" y="8" width="' + seg + '" height="26" rx="5" fill="' +
             (FUNDING_COLORS[k] || 'var(--line)') + '" opacity="0.85"/>' +
             '<text x="' + (x + seg / 2) + '" y="26" text-anchor="middle" font-size="10" fill="#10131a">' +
             esc(k) + '</text>';
      legend += '<span><span class="swatch" style="background:' + (FUNDING_COLORS[k] || 'var(--line)') +
                '"></span>' + esc(k) + '</span>';
      x += w / kinds.length;
    });
    legend += '</div>';
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>' + legend;
  }

  function ownershipSvg(profile) {
    var chain = [];
    if (profile.name) chain.push(profile.name);
    if (profile.owner && profile.owner !== profile.name) chain.push(profile.owner);
    if (profile.parent && chain.indexOf(profile.parent) === -1 &&
        profile.parent !== 'independent') chain.push(profile.parent);
    if (!chain.length) return '<p class="muted">ownership not on file</p>';
    var boxW = 190, gap = 34, h = 74, w = chain.length * (boxW + gap) + gap;
    var out = '';
    chain.forEach(function (label, i) {
      var x = gap + i * (boxW + gap);
      out += '<rect x="' + x + '" y="14" width="' + boxW + '" height="46" rx="8" fill="var(--bg)" stroke="var(--line)"/>' +
             '<text x="' + (x + boxW / 2) + '" y="41" text-anchor="middle" font-size="11" fill="currentColor">' +
             esc(label.length > 32 ? label.slice(0, 31) + '\u2026' : label) + '</text>';
      if (i < chain.length - 1) {
        var ax = x + boxW + 6;
        out += '<line x1="' + ax + '" y1="37" x2="' + (ax + gap - 12) + '" y2="37" stroke="var(--line)" stroke-width="2"/>' +
               '<polygon points="' + (ax + gap - 12) + ',37 ' + (ax + gap - 19) + ',32 ' + (ax + gap - 19) + ',42" fill="var(--line)"/>';
      }
    });
    out += '<text x="0" y="' + (h - 6) + '" font-size="11" fill="currentColor" opacity="0.7">publisher \u2192 owner \u2192 parent group</text>';
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>';
  }

  function balanceSvg(balance) {
    if (!balance) return '';
    var total = LEAN_ORDER.reduce(function (n, k) { return n + (balance[k] || 0); }, 0);
    var unknown = balance.unknown || 0;
    var w = 640, h = 58, x = 0;
    var out = '';
    if (!total && !unknown) return '<p class="muted">no other coverage found</p>';
    LEAN_ORDER.forEach(function (lean) {
      var n = balance[lean] || 0;
      if (!n) return;
      var seg = (n / (total + unknown)) * w;
      out += '<rect x="' + x + '" y="8" width="' + seg + '" height="24" rx="4" fill="' + LEAN_COLORS[lean] + '" opacity="0.85"/>' +
             '<text x="' + (x + seg / 2) + '" y="25" text-anchor="middle" font-size="10" fill="#10131a">' + n + '</text>';
      x += seg;
    });
    if (unknown) {
      var seg2 = (unknown / (total + unknown)) * w;
      out += '<rect x="' + x + '" y="8" width="' + seg2 + '" height="24" rx="4" fill="var(--line)"/>' +
             '<text x="' + (x + seg2 / 2) + '" y="25" text-anchor="middle" font-size="10" fill="currentColor">' + unknown + '</text>';
    }
    out += '<text x="0" y="50" font-size="11" fill="currentColor" opacity="0.7">' +
           'outlets by lean (left \u2192 right), plus those not in the dataset</text>';
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + out + '</svg>';
  }

  /* ── citation ────────────────────────────────────────────────────────── */
  function today() {
    var d = new Date();
    return d.toISOString().slice(0, 10);
  }
  function yearOf(date) {
    var m = String(date || '').match(/\d{4}/);
    return m ? m[0] : 'n.d.';
  }
  function dateOnly(date) {
    var s = String(date || '').trim();
    if (!s) return '';
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return s.slice(0, 24);
  }
  function authorList(c) {
    var a = (c.authors || []).filter(Boolean);
    return a.length ? a.join(', ') : (c.publisher || c.site || '');
  }
  function trimDot(s) { return String(s || '').replace(/\.\s*$/, ''); }

  function formats(c) {
    var acc = today(), y = yearOf(c.date);
    var authors = authorList(c);
    var first = ((c.authors || [])[0] || c.publisher || c.site || 'article');
    var key = (first.split(/[\s,]+/)[0] || 'article').toLowerCase().replace(/[^a-z0-9]/g, '') + y;
    return [
      ['APA', authors + ' (' + y + '). ' + trimDot(c.title) + '. ' + (c.site || '') +
              '. Retrieved ' + acc + ', from ' + c.url],
      ['MLA', (authors ? authors + '. ' : '') + '"' + trimDot(c.title) + '." ' + (c.site || '') +
              ', ' + (dateOnly(c.date) || 'n.d.') + ', ' + c.url + '. Accessed ' + acc + '.'],
      ['Chicago', (authors ? authors + '. ' : '') + '"' + trimDot(c.title) + '." ' + (c.site || '') +
                  ', ' + (dateOnly(c.date) || 'n.d.') + '. ' + c.url + '.'],
      ['BibTeX', '@misc{' + key + ',\n  author = {' + (c.authors || []).join(' and ') + '},\n' +
                 '  title = {' + trimDot(c.title) + '},\n  year = {' + y + '},\n' +
                 '  publisher = {' + (c.publisher || c.site || '') + '},\n' +
                 '  url = {' + c.url + '},\n  note = {Accessed ' + acc + '}\n}']
    ];
  }

  function renderCitation() {
    var rows = [
      ['Title', CITE.title], ['Author', (CITE.authors || []).join('; ')],
      ['Publisher', CITE.publisher], ['Published', CITE.date],
      ['Site', CITE.site], ['Language', CITE.lang],
      ['URL', CITE.url], ['Canonical', CITE.canonical !== CITE.url ? CITE.canonical : ''],
      ['Accessed', today()]
    ].filter(function (r) { return r[1]; });
    $('cite-fields').innerHTML = rows.map(function (r) {
      return '<tr><td class="k">' + esc(r[0]) + '</td><td class="v">' +
             (r[0] === 'URL' || r[0] === 'Canonical'
               ? '<a href="' + esc(r[1]) + '">' + esc(r[1]) + '</a>' : esc(r[1])) + '</td></tr>';
    }).join('');

    var host = '';
    try { host = new URL(CITE.url || PAGE_URL).hostname; } catch (e) { host = ''; }
    if (CITE.title) $('title').textContent = CITE.title;
    $('site').textContent = CITE.site || host || '?';
    $('pubdate').textContent = dateOnly(CITE.date) || 'date not stated';
    $('open-src').href = CITE.url || PAGE_URL || '#';

    var html = formats(CITE).map(function (f) {
      return '<div class="format"><div class="name">' + esc(f[0]) + '</div><code>' + esc(f[1]) +
             '</code><button data-fmt="' + esc(f[0]) + '">copy</button></div>';
    }).join('');
    $('cite-formats').innerHTML = html;
    [].forEach.call($('cite-formats').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        var f = formats(CITE).filter(function (x) { return x[0] === b.dataset.fmt; })[0];
        if (f) copy(f[1], f[0]);
      });
    });
    var missing = [];
    if (!(CITE.authors || []).length) missing.push('author');
    if (!CITE.date) missing.push('publication date');
    $('cite-note').textContent = missing.length
      ? 'The page does not state its ' + missing.join(' or ') + ' — those fields are empty rather than guessed.'
      : 'All citation fields were found on the page itself.';
    $('copy-cite').addEventListener('click', function () { copy(formats(CITE)[0][1], 'APA'); });
  }

  /* ── section renderers ───────────────────────────────────────────────── */
  function renderMetrics(m) {
    $('words').textContent = m.words + ' words \u00b7 ' + m.readingMin + ' min';
    var quoteShare = m.words ? Math.round((m.quotes * 12 / Math.max(1, m.words)) * 100) : 0;
    // Fixed colours, not theme variables: a theme whose accent is also green would
    // flatten the three groups into one colour.
    var C_LEN = '#6fb3ff', C_SRC = '#7dcf8a', C_WARN = '#e0c07e', C_MISC = '#8f8f8f';
    $('metrics-diagram').innerHTML = barsSvg([
      { label: 'words', value: m.words, color: C_LEN },
      { label: 'paragraphs', value: m.paras, color: C_LEN },
      { label: 'sentences', value: m.sentences, color: C_LEN },
      { label: 'quoted passages', value: m.quotes, color: C_SRC },
      { label: 'numbers / stats', value: m.digits, color: C_SRC },
      { label: 'named attributions', value: m.named, color: C_SRC },
      { label: 'vague sourcing', value: m.anon, color: C_WARN },
      { label: 'outbound links', value: m.links, color: C_MISC },
      { label: 'images', value: m.images, color: C_MISC }
    ]);
    var notes = [
      'reading time: about ' + m.readingMin + ' minute(s) at 220 words/min',
      'quoting: ' + m.quotes + ' quoted passage(s)' + (quoteShare ? ' (roughly ' + quoteShare + '% quote density)' : ''),
      'sourcing: ' + m.named + ' attributed statement(s), ' + m.anon + ' vague attribution phrase(s) — a high vague count against a low attributed count is worth a second look',
      'headline: ' + m.headlineWords + ' words' + (m.headlineQuestion ? ', phrased as a question' : ''),
      m.cueCount ? 'framing cues found ' + m.cueCount + ' time(s): ' + m.cues.join(', ')
                 : 'no words from the framing-cue list found in the headline or opening paragraphs'
    ];
    $('metrics-notes').innerHTML = notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
  }

  function refreshSpectrum() {
    var el = $('spectrum');
    if (el) el.innerHTML = spectrumSvg(window.__profile || {}, window.__balance || null);
  }

  function renderPublisher(host) {
    return api('/publisher', { domain: host }).then(function (data) {
      var p = data.profile || {};
      var head = '';
      if (p.name) {
        head += '<span class="chip">' + esc(p.name) + (p.country ? ' \u00b7 ' + esc(p.country) : '') + '</span>';
        head += '<span class="chip ' + esc(p.lean || 'unknown') + '">' + esc((p.lean || 'no lean on file').replace('-', ' ')) + '</span>';
        head += '<span class="chip factual-' + esc(p.factual || '') + '">factual: ' + esc(p.factual || '?') + '</span>';
        (p.funding || []).forEach(function (f) { head += '<span class="chip money">' + esc(f) + '</span>'; });
      } else {
        head = '<span class="chip unknown">no profile on file for ' + esc(host) + '</span>';
      }
      $('publisher-head').innerHTML = head;
      window.__profile = p;
      refreshSpectrum();
      $('factual').innerHTML = factualSvg(p.factual);
      $('funding').innerHTML = fundingSvg(p.funding);
      $('ownership').innerHTML = ownershipSvg(p);

      var src = (p.sources || []).map(function (u) {
        return '<a href="' + esc(u) + '">source</a>';
      }).join(' \u00b7 ');
      $('publisher-note').innerHTML = (p.owner ? 'Owner: ' + esc(p.owner) + '. ' : '') +
        (p.parent ? 'Parent: ' + esc(p.parent) + '. ' : '') +
        (src ? 'Verify: ' + src + '. ' : '') +
        (p.name ? '' : '<a href="https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(host) +
                         '">look this publisher up</a>.') +
        ' Ratings are curated, not measured.';

      if (data.wikipedia && data.wikipedia.extract) {
        $('wiki').innerHTML = '<h3 class="muted">Background</h3><p>' + esc(data.wikipedia.extract) +
          (data.wikipedia.url ? ' <a href="' + esc(data.wikipedia.url) + '">(source)</a>' : '') + '</p>';
      } else {
        $('wiki').innerHTML = '';
      }
      return p;
    }).catch(function () {
      $('publisher-head').innerHTML = '<span class="chip unknown">publisher lookup failed</span>';
    });
  }

  function renderCoverage(title, url) {
    return api('/coverage', { title: title, url: url }).then(function (data) {
      window.__balance = data.balance || null;
      $('coverage-balance').innerHTML = balanceSvg(data.balance);
      var list = (data.outlets || []);
      $('coverage-list').innerHTML = list.length ? list.map(function (o) {
        return '<li><span class="chip ' + esc(o.known ? o.lean : 'unknown') + '">' +
               esc(o.known ? o.lean.replace('-', ' ') : 'unrated') + '</span>' +
               '<span class="hl"><a href="' + esc(o.url) + '">' + esc(o.headline) + '</a></span>' +
               '<span class="muted">' + esc(o.name) + '</span></li>';
      }).join('') : '<li class="muted">no other outlets found for this story</li>';
      $('coverage-note').textContent = list.length
        ? 'Found via a news search for "' + (data.query || '') + '". The lean chips come from the same curated ' +
          'dataset, so unrated outlets stay grey rather than being guessed. Comparing the headlines above is the ' +
          'point: same facts, different emphasis.'
        : 'The news search returned nothing for this headline\'s keywords.';
      refreshSpectrum();
    }).catch(function () {
      $('coverage-list').innerHTML = '<li class="muted">coverage search failed (offline?)</li>';
    });
  }

  function renderFraming(result) {
    if (!result || typeof result !== 'object') {
      $('framing-body').innerHTML = '<p class="muted">The model did not return a usable answer.</p>';
      return;
    }
    var terms = (result.loaded_terms || []).map(function (t) {
      return '<span class="chip money">' + esc(t) + '</span>';
    }).join(' ');
    $('framing-body').innerHTML =
      '<p><strong>' + esc(result.claim || '') + '</strong></p>' +
      '<h3>Tone</h3><p>' + esc(result.tone || '?') +
      (result.confidence ? ' <span class="muted">(confidence: ' + esc(result.confidence) + ')</span>' : '') + '</p>' +
      '<h3>How it is framed</h3><p>' + esc(result.framing || '') + '</p>' +
      (terms ? '<h3>Loaded terms</h3><p>' + terms + '</p>' : '') +
      (result.omissions ? '<h3>What it leaves out</h3><p>' + esc(result.omissions) + '</p>' : '') +
      '<p class="note">Judged by the local model on the article text alone — a reading aid, not a fact.</p>';
  }

  function runFraming() {
    var btn = $('framing-run');
    var doc = new DOMParser().parseFromString(ARTICLE_HTML, 'text/html');
    var text = ((doc.body ? doc.body.textContent : '') || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
    if (!text) return;
    btn.disabled = true;
    btn.textContent = 'asking the local model\u2026';
    $('framing-body').innerHTML = '<p class="muted">The local model is reading the article \u2014 this can take a minute.</p>';
    api('/framing', {}, 'POST', JSON.stringify({ title: CITE.title || document.title, text: text }))
      .then(function (r) {
        if (r && r.ok) renderFraming(r.result);
        else $('framing-body').innerHTML = '<p class="muted">Framing analysis failed: ' +
             esc((r && r.error) || 'unknown error') + '</p>';
      })
      .catch(function () { $('framing-body').innerHTML = '<p class="muted">Framing request failed.</p>'; })
      .then(function () { btn.disabled = false; btn.textContent = 'analyse framing again'; });
  }

  /* ── init ────────────────────────────────────────────────────────────── */
  applyColors();
  var m = metricsOf(ARTICLE_HTML);
  renderMetrics(m);
  renderCitation();

  var host = '';
  try { host = new URL(CITE.url || PAGE_URL).hostname; } catch (e) { host = ''; }
  var title = CITE.title || document.body.dataset.title || document.title;
  renderPublisher(host);
  renderCoverage(title, CITE.url || PAGE_URL);

  $('framing-run').addEventListener('click', runFraming);
  document.title = 'Status — ' + (CITE.title || document.body.dataset.title || 'article');
})();

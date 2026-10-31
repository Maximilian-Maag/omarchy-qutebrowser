// Harness tests for status/status.js — the article status page.
//
// status.js is a DOM-only IIFE with no export surface, and it was the repo's one
// "tracked, visible gap": no test at all, and exempt from mutation for that reason.
// This closes the gap with the technique the rest of tests/js already uses — no npm,
// no jsdom. Two layers:
//
//   * the PURE helpers are sliced out of the shipped source and driven directly
//     (esc, the metric regexes, the SVG builders, the citation formats);
//   * the WHOLE shipped file is run in a `node:vm` context against a small fake DOM
//     and a canned fetch, so its init path — metrics, citation, publisher, coverage —
//     is exercised end to end.
//
// The fake DOM is intentionally tiny and only answers the selectors status.js uses;
// it exists to prove the init path runs and renders, not to be a browser.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'status', 'status.js'), 'utf8');

// ── slicing pure helpers out of the shipped source (as tests/js does) ────────

function slice(names) {
    const parts = [];
    for (const name of names) {
        const needle = (name.startsWith('var ') ? '  var ' : '  function ')
            + name.replace(/^var /, '');
        const start = SOURCE.indexOf(needle);
        assert.notStrictEqual(start, -1, `not found in source: ${needle}`);
        const rest = SOURCE.slice(start + 2);
        const next = /\n  (?:function [A-Za-z_$]|var [A-Za-z_$]|window\.|const |let |\/\/)/.exec(rest);
        parts.push(rest.slice(0, next ? next.index : rest.length));
    }
    return parts.join('\n');
}

function sandbox(code, extra) {
    const ctx = { console, Date, Math, JSON, String, Object, Array, RegExp, isNaN, ...extra };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx;
}

// A DOMParser just faithful enough for the selectors metricsOf uses.
function fakeDomParser() {
    return class {
        parseFromString(html, _type) {
            const text = String(html)
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ');
            const body = { textContent: text };
            const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
            const paras = [...String(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
                .map((m) => ({ textContent: m[1].replace(/<[^>]+>/g, '') }));
            return {
                body,
                documentElement: body,
                querySelector: (sel) => (sel === 'h1' && h1
                    ? { textContent: h1[1].replace(/<[^>]+>/g, '') } : null),
                querySelectorAll: (sel) => {
                    if (sel === 'p') return paras;
                    if (sel === 'img') return [...String(html).matchAll(/<img\b[^>]*>/gi)];
                    if (sel === 'a[href^="http"]')
                        return [...String(html).matchAll(/<a\b[^>]*href="https?:[^"]*"[^>]*>/gi)];
                    return [];
                }
            };
        }
    };
}

const PURE = ['esc', 'metricsOf', 'barsSvg', 'spectrumSvg', 'factualSvg', 'fundingSvg',
              'ownershipSvg', 'balanceSvg', 'today', 'yearOf', 'dateOnly', 'authorList',
              'trimDot', 'formats',
              'var LEAN_COLORS', 'var LEAN_ORDER', 'var FUNDING_COLORS', 'var CUE_RE',
              'var CITE'];

function pureCtx(cite) {
    // The sliced "var CITE = window.CITE || {}" reads window, so the cite object is
    // supplied there rather than as a bare sandbox global.
    return sandbox(slice(PURE), {
        DOMParser: fakeDomParser(),
        window: { TOKEN: '', COLORS: {}, CITE: cite || {}, ARTICLE_HTML: '' },
    });
}

// ── esc ─────────────────────────────────────────────────────────────────────

test('esc neutralises every HTML metacharacter', () => {
    const c = pureCtx();
    assert.strictEqual(c.esc('<a href="x">&\'</a>'),
                       '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.strictEqual(c.esc(null), '');
    assert.strictEqual(c.esc(0), '0');
});

// ── metricsOf: the counting logic a reader trusts ───────────────────────────

test('metricsOf counts words, paragraphs, images and links', () => {
    const c = pureCtx();
    const html = '<h1>Flood hits the valley?</h1>'
        + '<p>' + 'a'.repeat(50) + '</p><p>short</p>'
        + '<img src="a.png"><img src="b.png">'
        + '<a href="http://x.test">x</a><a href="/local">l</a>';
    const m = c.metricsOf(html);
    assert.strictEqual(m.images, 2);
    assert.strictEqual(m.links, 1, 'only absolute http(s) links count');
    assert.strictEqual(m.paras, 1, 'a paragraph under 40 chars does not count');
    assert.strictEqual(m.headlineQuestion, true, 'a headline ending in ? is flagged');
    assert.ok(m.words > 5);
    assert.ok(m.readingMin >= 1);
});

test('metricsOf counts quotes and numbers, and finds framing cues', () => {
    const c = pureCtx();
    const html = '<h1>Shocking chaos</h1><p>'
        + 'Der Wert liegt bei 42 Prozent und \u201eein Zitat\u201c. '
        + 'Another "quote" here with 1,5 Millionen Euro.</p>';
    const m = c.metricsOf(html);
    assert.strictEqual(m.quotes, 2, 'a curly pair and a straight pair = two quotes');
    assert.ok(m.digits >= 2, 'percent/stats get counted: ' + m.digits);
    assert.ok(m.cues.includes('shocking') && m.cues.includes('chaos'),
              'headline cues are found: ' + JSON.stringify(m.cues));
    assert.strictEqual(m.headlineWords, 2);
});

test('metricsOf counts named versus vague attributions', () => {
    const c = pureCtx();
    const m = c.metricsOf('<p>' + 'x'.repeat(50)
        + ' The minister said it, a source said otherwise, according to the report.</p>');
    assert.ok(m.named >= 3, 'said/said/according to: ' + m.named);
    assert.ok(m.anon >= 1, 'a vague "a source" counts: ' + m.anon);
});

// ── the SVG builders ────────────────────────────────────────────────────────

test('barsSvg sizes bars against the largest value', () => {
    const c = pureCtx();
    const svg = c.barsSvg([{ label: 'a', value: 10 }, { label: 'b', value: 5 }], '%');
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.ok(svg.includes('a') && svg.includes('b'));
    assert.ok(svg.includes('10%') && svg.includes('5%'), 'values carry the unit');
});

test('spectrumSvg marks the active lean and the state-funded note', () => {
    const c = pureCtx();
    const active = c.spectrumSvg({ lean: 'left' }, { left: 2, right: 1 });
    assert.ok(active.includes('this outlet'), 'active lean gets a marker');
    assert.ok(active.includes('2 outlets'), 'plural outlets');
    const one = c.spectrumSvg({ lean: 'right' }, { right: 1 });
    assert.ok(one.includes('1 outlet') && !one.includes('1 outlets'), 'singular outlet');
    const state = c.spectrumSvg({ lean: 'state' }, {});
    assert.ok(state.includes('off the left/right axis'));
});

test('fundingSvg and balanceSvg fall back when there is nothing to draw', () => {
    const c = pureCtx();
    assert.ok(c.fundingSvg([]).includes('funding model not on file'));
    assert.ok(c.fundingSvg(null).includes('funding model not on file'));
    assert.ok(c.balanceSvg(null) === '');
    assert.ok(c.balanceSvg({ unknown: 0 }).includes('no other coverage found'));
    const drawn = c.balanceSvg({ left: 1, unknown: 1 });
    assert.ok(drawn.includes('<svg') && drawn.includes('not in the dataset'));
});

test('ownershipSvg builds a chain and refuses to guess', () => {
    const c = pureCtx();
    assert.ok(c.ownershipSvg({}).includes('ownership not on file'));
    const chain = c.ownershipSvg({ name: 'Paper', owner: 'Group', parent: 'Holding' });
    assert.ok(chain.includes('Paper') && chain.includes('Group') && chain.includes('Holding'));
    assert.ok(chain.includes('publisher' ) && chain.includes('parent group'));
    const indep = c.ownershipSvg({ name: 'Indie', parent: 'independent' });
    assert.ok(!indep.includes('independent'), 'an "independent" parent is not drawn as an owner');
});

// ── citation helpers ────────────────────────────────────────────────────────

test('yearOf and dateOnly recover a year and a date', () => {
    const c = pureCtx();
    assert.strictEqual(c.yearOf('2024-05-01'), '2024');
    assert.strictEqual(c.yearOf('no year here'), 'n.d.');
    assert.strictEqual(c.dateOnly('2024-05-01T10:00:00Z'), '2024-05-01');
    assert.strictEqual(c.dateOnly(''), '');
    assert.strictEqual(c.dateOnly('sometime in spring'), 'sometime in spring');
});

test('authorList falls back to publisher then site', () => {
    const c = pureCtx();
    assert.strictEqual(c.authorList({ authors: ['A', 'B'] }), 'A, B');
    assert.strictEqual(c.authorList({ authors: [''], publisher: 'P' }), 'P');
    assert.strictEqual(c.authorList({ site: 'S' }), 'S');
    assert.strictEqual(c.authorList({}), '');
});

test('trimDot strips one trailing period only', () => {
    const c = pureCtx();
    assert.strictEqual(c.trimDot('Title.'), 'Title');
    assert.strictEqual(c.trimDot('Title...'), 'Title..');
    assert.strictEqual(c.trimDot('Title'), 'Title');
    assert.strictEqual(c.trimDot(null), '');
});

test('formats renders APA, MLA, Chicago and BibTeX from the page', () => {
    const cite = {
        authors: ['Jane Doe'], title: 'The Title.', site: 'Example',
        publisher: 'Example Press', date: '2024-05-01', url: 'https://example.com/a',
    };
    const c = pureCtx(cite);
    const rows = c.formats(cite);
    const byName = Object.fromEntries(rows);
    // rows come from the vm realm, so normalise before a prototype-sensitive compare
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rows.map((r) => r[0]))),
                           ['APA', 'MLA', 'Chicago', 'BibTeX']);
    assert.ok(byName.APA.startsWith('Jane Doe (2024). The Title. Example.'), byName.APA);
    assert.ok(byName.MLA.includes('"The Title."'), 'MLA quotes the title');
    assert.ok(byName.Chicago.includes('2024-05-01'), 'Chicago carries the date');
    assert.ok(byName.BibTeX.startsWith('@misc{'), 'BibTeX has an entry key');
    assert.ok(byName.BibTeX.includes('author = {Jane Doe}'), 'and a single author verbatim');
    assert.ok(byName.BibTeX.includes('year = {2024}'));
});

test('formats joins multiple authors with "and" for BibTeX', () => {
    const cite = { authors: ['A One', 'B Two'], title: 'T', url: 'u' };
    const c = pureCtx(cite);
    const bib = Object.fromEntries(c.formats(cite)).BibTeX;
    assert.ok(bib.includes('author = {A One and B Two}'), bib);
});

// ── the whole shipped file, driven against a fake DOM ───────────────────────

const HTML = '<h1>Quietly, a bridge reopens</h1>'
    + '<p>' + 'The council said the bridge would reopen on 12 May. '.repeat(4) + '</p>'
    + '<a href="https://example.com/src">source</a><img src="x.png">';

const FETCH_REPLIES = {
    '/publisher': { profile: { name: 'Example Times', country: 'DE', lean: 'center',
                               factual: 'high', funding: ['subscriptions'], owner: 'Group' },
                    wikipedia: { extract: 'A newspaper.', url: 'https://en.wikipedia.org/x' } },
    '/coverage': { balance: { left: 1, center: 2, unknown: 1 },
                   outlets: [{ name: 'Other', headline: 'Bridge to reopen', url: 'https://o.test',
                               lean: 'left', known: true }],
                   query: 'bridge reopen' },
    '/framing': { ok: true, result: { claim: 'Reopening', tone: 'neutral',
                                      framing: 'civic', loaded_terms: ['quietly'] } },
};

function el() {
    return {
        id: '', textContent: '', innerHTML: '', value: '', href: '', disabled: false,
        dataset: {}, style: { setProperty() {} },
        classList: { add() {}, remove() {} },
        addEventListener(n, fn) { (this._h = this._h || {})[n] = fn; },
        querySelectorAll: () => [],
    };
}

function loadStatus({ html = HTML, cite = { title: 'Quietly, a bridge reopens',
                                           url: 'https://example.com/a' } } = {}) {
    const els = new Map();
    const byId = (id) => {
        if (!els.has(id)) { const e = el(); e.id = id; els.set(id, e); }
        return els.get(id);
    };
    const document = {
        title: 'page', execCommand: () => false,
        documentElement: { style: { setProperty() {} } },
        body: Object.assign(el(), { dataset: { url: 'https://example.com/a', title: 'x' } }),
        getElementById: byId,
        createElement: () => el(),
        querySelectorAll: () => [],
    };
    const window = { TOKEN: 'tok', COLORS: { accent: '#abc' }, CITE: cite, ARTICLE_HTML: html };
    const requests = [];
    const fetch = (url, opts) => {
        const p = String(url).split('?')[0];
        requests.push({ path: p, method: (opts && opts.method) || 'GET', url: String(url) });
        const body = FETCH_REPLIES[p];
        return Promise.resolve({ json: () => Promise.resolve(body === undefined ? {} : body) });
    };
    const sandboxObj = {
        window, document, fetch, DOMParser: fakeDomParser(), URL,
        setTimeout: (fn) => { try { fn(); } catch (e) { /* toast timers */ } },
        navigator: {}, console,
    };
    vm.createContext(sandboxObj);
    vm.runInContext(SOURCE, sandboxObj, { filename: 'status.js' });
    return { byId, requests, window };
}

test('init renders metrics and citation without a browser', () => {
    const { byId } = loadStatus();
    const diagram = byId('metrics-diagram').innerHTML;
    assert.ok(diagram.startsWith('<svg'), 'metrics diagram is an SVG: ' + diagram.slice(0, 40));
    assert.ok(/\d+ words \u00b7 \d+ min/.test(byId('words').textContent),
              'word/minute summary: ' + byId('words').textContent);
    assert.ok(byId('metrics-notes').innerHTML.includes('<li>'), 'notes are listed');
    const formats = byId('cite-formats').innerHTML;
    assert.ok(formats.includes('APA') && formats.includes('BibTeX'), 'citation formats render');
    assert.ok(byId('cite-fields').innerHTML.includes('example.com/a'), 'the URL is a field');
    assert.ok(byId('cite-note').textContent.length > 0, 'the note explains missing fields');
});

test('init asks the server for the publisher and the coverage', async () => {
    const { byId, requests } = loadStatus();
    await new Promise((r) => setImmediate(r));
    const asked = requests.map((r) => r.path);
    assert.ok(asked.includes('/publisher'), 'asked for the publisher: ' + asked.join(','));
    assert.ok(asked.includes('/coverage'), 'asked for coverage');
    assert.ok(requests.every((r) => r.url.includes('t=tok')), 'every call carries the token');
    assert.ok(byId('publisher-head').innerHTML.includes('Example Times'),
              'the publisher chip renders: ' + byId('publisher-head').innerHTML);
    assert.ok(byId('publisher-head').innerHTML.includes('factual: high'));
    assert.ok(byId('wiki').innerHTML.includes('A newspaper.'), 'the wikipedia blurb renders');
    assert.ok(byId('coverage-list').innerHTML.includes('Bridge to reopen'), 'outlets render');
    assert.ok(byId('coverage-balance').innerHTML.includes('<svg'), 'the balance bar renders');
});

test('a failed publisher lookup degrades to a visible chip', async () => {
    const els = new Map();
    const byId = (id) => {
        if (!els.has(id)) { const e = el(); e.id = id; els.set(id, e); }
        return els.get(id);
    };
    const document = {
        title: 'page', execCommand: () => false,
        documentElement: { style: { setProperty() {} } },
        body: Object.assign(el(), { dataset: {} }),
        getElementById: byId, createElement: () => el(), querySelectorAll: () => [],
    };
    const ctx = {
        window: { TOKEN: '', COLORS: {}, CITE: {}, ARTICLE_HTML: '<p>' + 'x'.repeat(50) + '</p>' },
        document, URL, DOMParser: fakeDomParser(),
        setTimeout: () => {}, navigator: {}, console,
        fetch: () => Promise.reject(new Error('offline')),
    };
    vm.createContext(ctx);
    vm.runInContext(SOURCE, ctx, { filename: 'status.js' });
    await new Promise((r) => setImmediate(r));
    assert.ok(byId('publisher-head').innerHTML.includes('publisher lookup failed'));
    assert.ok(byId('coverage-list').innerHTML.includes('coverage search failed'));
});

// Tests for userscripts/omarchy-chrome-identity.js.
//
// Context: sites behind managed bot-detection (LinkedIn/Cloudflare, Kleinanzeigen and
// immowelt/DataDome) answer this browser with "We detected unusual activity from your device or
// network" / a challenge interstitial. The engine differs from Chrome in a few JavaScript tells
// and a detection suite reads them as a fake browser. Correcting the JS tells is the second half
// of the stock-Chrome identity (the request half lives in config/config.py).
//
// The script is an IIFE, so it is evaluated whole in a node:vm sandbox with stand-ins for
// `navigator` and `window`. That exercises the code that actually runs, with no npm deps.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'userscripts', 'omarchy-chrome-identity.js'), 'utf8');

// What QtWebEngine actually reports: the GREASE brand first, then Chromium, no window.chrome,
// pdfViewerEnabled false. Measured on the live engine — grease-first is why the fixture used to
// (wrongly) read the version off brands[0].
function engineBrands() {
    return [
        { brand: 'Not=A?Brand', version: '24' },
        { brand: 'Chromium', version: '140' },
    ];
}

function run() {
    const proto = {};
    const real = { brands: engineBrands(), mobile: false, platform: 'Linux' };
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true, get() { return real; },
    });
    Object.defineProperty(proto, 'pdfViewerEnabled', {
        configurable: true, enumerable: true, get() { return false; },
    });
    const navigator = Object.create(proto);
    const window = {};
    const sandbox = { navigator, window, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { navigator, window, proto, real };
}

test('the brands gain Google Chrome, which is the tell a detection suite checks', () => {
    const { navigator } = run();
    const brands = navigator.userAgentData.brands;
    assert.strictEqual(brands[0].brand, 'Google Chrome');
    assert.strictEqual(brands[0].version, '140', 'it should carry the engine version');
    assert.ok(brands.some(b => b.brand === 'Chromium'), 'the real brands are kept, not replaced');
});

test('the brands are ordered like Chrome and carry the real major version', () => {
    // Engine order is grease-first (["Not=A?Brand 24", "Chromium 140"]); Chrome leads with the real
    // brands and keeps the grease brand last. And "Google Chrome" must take the Chromium major
    // (140), not the grease version (24) that brands[0] would have supplied.
    const { navigator } = run();
    const brands = navigator.userAgentData.brands;
    assert.deepStrictEqual([...brands.map(b => b.brand)],
                           ['Google Chrome', 'Chromium', 'Not=A?Brand']);
    assert.strictEqual(brands[0].version, '140');
});

test('without a Chromium brand the major falls back to the engine brand', () => {
    // Exercises the `(source[0] && source[0].version) || ''` fallback: no Chromium entry means the
    // major comes from the first remaining brand. Written because the fallback is otherwise
    // unreachable and its mutants survived.
    const proto = {};
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true,
        get() {
            return { brands: [{ brand: 'Not=A?Brand', version: '24' }], mobile: false, platform: 'Linux' };
        },
    });
    const navigator = Object.create(proto);
    const sandbox = { navigator, window: {}, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    const brands = navigator.userAgentData.brands;
    assert.strictEqual(brands[0].brand, 'Google Chrome');
    assert.strictEqual(brands[0].version, '24', 'falls back to the first engine brand');
});

test('the engine\'s own brand list is not mutated', () => {
    const { real } = run();
    assert.ok(!real.brands.some(b => b.brand === 'Google Chrome'),
              'the correction must not write into the engine\'s array');
    assert.strictEqual(real.brands.length, 2);
});

test('the correction lives on the PROTOTYPE, not as an own property of navigator', () => {
    // An own property on the instance is the shape that got the browser refused on Google.
    const { navigator, proto } = run();
    assert.strictEqual(Object.getOwnPropertyDescriptor(navigator, 'userAgentData'), undefined,
                       'no own property on the navigator instance');
    assert.strictEqual(typeof Object.getOwnPropertyDescriptor(proto, 'userAgentData').get,
                       'function', 'the prototype getter is what is patched');
});

test('window.chrome is populated the way real Chrome has it', () => {
    const { window } = run();
    assert.strictEqual(typeof window.chrome, 'object');
    assert.strictEqual(typeof window.chrome.app, 'object');
    assert.strictEqual(typeof window.chrome.runtime, 'object');
    assert.strictEqual(typeof window.chrome.csi, 'function');
    assert.strictEqual(typeof window.chrome.loadTimes, 'function');
});

test('pdfViewerEnabled reports true, as a desktop Chrome with a viewer does', () => {
    const { navigator } = run();
    assert.strictEqual(navigator.pdfViewerEnabled, true);
});

test('everything stays configurable, so nothing is locked down irreversibly', () => {
    const { proto } = run();
    assert.strictEqual(Object.getOwnPropertyDescriptor(proto, 'userAgentData').configurable, true);
    assert.strictEqual(Object.getOwnPropertyDescriptor(proto, 'pdfViewerEnabled').configurable, true);
});

test('it touches no WebAuthn API', () => {
    const { navigator } = run();
    assert.strictEqual(navigator.PublicKeyCredential, undefined,
                       'this script must never touch PublicKeyCredential');
    const code = SOURCE.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/PublicKeyCredential\s*[.[(]/.test(code), 'and must not call into it either');
});

test('it never throws when the browser APIs are absent', () => {
    const proto = {};
    const navigator = Object.create(proto);
    const sandbox = { navigator, window: {}, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(SOURCE, sandbox));
});

test('the corrected userAgentData properties stay enumerable and configurable', () => {
    const { navigator } = run();
    for (const key of ['brands', 'mobile', 'platform']) {
        const d = Object.getOwnPropertyDescriptor(navigator.userAgentData, key);
        assert.strictEqual(d.enumerable, true, key + ' enumerable');
        assert.strictEqual(d.configurable, true, key + ' configurable');
    }
});

test('an engine already reporting Google Chrome gets no duplicate entry', () => {
    const proto = {};
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true,
        get() {
            return { brands: [{ brand: 'Google Chrome', version: '140' }], mobile: false, platform: 'Linux' };
        },
    });
    Object.defineProperty(proto, 'pdfViewerEnabled', {
        configurable: true, enumerable: true, get() { return false; },
    });
    const navigator = Object.create(proto);
    const sandbox = { navigator, window: {}, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    const chrome = navigator.userAgentData.brands.filter(b => b.brand === 'Google Chrome');
    assert.strictEqual(chrome.length, 1, 'exactly one Google Chrome entry');
});

test('an absent userAgentData does not stop the other corrections', () => {
    // The `uadDesc && typeof uadDesc.get === 'function'` guard must not throw when the descriptor
    // is missing, or the rest of the script (window.chrome, pdfViewer) would never run.
    const proto = {};
    Object.defineProperty(proto, 'pdfViewerEnabled', {
        configurable: true, enumerable: true, get() { return false; },
    });
    const navigator = Object.create(proto);
    const window = {};
    const sandbox = { navigator, window, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(SOURCE, sandbox));
    assert.strictEqual(typeof window.chrome, 'object', 'window.chrome is still populated');
    assert.strictEqual(navigator.pdfViewerEnabled, true, 'and the pdf answer is still corrected');
});

test('a userAgentData without brands does not throw when the page reads it', () => {
    // The `!real || !real.brands` early-return must hold: an `&&` there would fall through and
    // dereference an undefined brands array, throwing out of the getter into the page.
    const proto = {};
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true,
        get() { return { mobile: false, platform: 'Linux' }; },
    });
    const navigator = Object.create(proto);
    const sandbox = { navigator, window: {}, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    assert.doesNotThrow(() => navigator.userAgentData);
    assert.strictEqual(navigator.userAgentData.mobile, false);
});

test('it leaves pdfViewerEnabled alone when there is no getter to wrap', () => {
    // A value (not getter) descriptor must not be replaced: the `navPdfDesc && typeof get`
    // guard, mutated to `||`, would redefine it and turn a false value into true.
    const proto = {};
    Object.defineProperty(proto, 'pdfViewerEnabled', { configurable: true, value: false });
    const navigator = Object.create(proto);
    const sandbox = { navigator, window: {}, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    assert.strictEqual(navigator.pdfViewerEnabled, false, 'a non-getter must not be replaced');
    assert.strictEqual(Object.getOwnPropertyDescriptor(proto, 'pdfViewerEnabled').get, undefined);
});

// ── scope: the identity must not leak onto arbitrary hosts ──────────────────────
test('@match covers exactly the bot-managed hosts and nothing wildcard', () => {
    const matches = [...SOURCE.matchAll(/^\/\/\s*@match\s+(\S+)/gm)].map(m => m[1]);
    assert.ok(matches.length > 0, 'the script declares no @match, so its scope is unasserted');
    const allowed = ['linkedin.com', 'kleinanzeigen.de', 'immowelt.de'];
    for (const pattern of matches) {
        assert.ok(allowed.some(h => pattern.includes(h)),
                  pattern + ' must stay on a bot-managed host');
        assert.ok(!pattern.includes('*://*'),
                  pattern + ' must never be a match-all pattern');
    }
    for (const host of allowed) {
        assert.ok(matches.some(p => p.includes(host)), 'no @match covers ' + host);
    }
});

test('the script never rewrites plugins, mimeTypes or webdriver', () => {
    const code = SOURCE.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const needle of ['navigator.plugins', 'navigator.mimeTypes', 'navigator.webdriver',
                          'navigator.credentials']) {
        assert.ok(!code.includes(needle), 'it must not touch ' + needle);
    }
});

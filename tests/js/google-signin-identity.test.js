// Tests for userscripts/omarchy-google-signin-chrome-identity.js.
//
// Context: Google refuses this browser at submit ("Couldn't sign you in — This browser or app may
// not be secure") because the engine differs from Chrome in a few tells. Correcting them is what
// makes Google's sign-in — and its passkey — work. Measured, and verified live.
//
// The script is an IIFE, so it is evaluated whole in a node:vm sandbox with stand-ins for
// `navigator` and `window`. That exercises the code that actually runs, with no npm deps.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'userscripts', 'omarchy-google-signin-chrome-identity.js'), 'utf8');

// What QtWebEngine actually reports: the GREASE brand first, then Chromium, no window.chrome,
// pdfViewerEnabled false. Measured on the live engine — grease-first is why the fixture used to
// (wrongly) read the version off brands[0].
function engineBrands() {
    return [
        { brand: 'Not=A?Brand', version: '24' },
        { brand: 'Chromium', version: '140' },
    ];
}

function run(skip) {
    const proto = {};
    const real = {
        brands: engineBrands(),
        mobile: false,
        platform: 'Linux',
    };
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true, get() { return real; },
    });
    Object.defineProperty(proto, 'pdfViewerEnabled', {
        configurable: true, enumerable: true, get() { return false; },
    });
    const navigator = Object.create(proto);
    const window = skip ? {} : {};
    const sandbox = { navigator: skip ? undefined : navigator, window, Object, Array, Proxy };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { navigator, window, proto, real };
}

test('the brands gain Google Chrome, which is the tell Google checks', () => {
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

test('mobile and platform are preserved rather than invented', () => {
    const { navigator } = run();
    assert.strictEqual(navigator.userAgentData.mobile, false);
    assert.strictEqual(navigator.userAgentData.platform, 'Linux');
});

test('the correction lives on the PROTOTYPE, not as an own property of navigator', () => {
    // The retired google-signin-compat.js shim defined it on the instance - real Chrome keeps it on
    // Navigator.prototype - and that is the shape that got the browser refused.
    const { navigator, proto } = run();
    assert.strictEqual(Object.getOwnPropertyDescriptor(navigator, 'userAgentData'), undefined,
                       'no own property on the navigator instance');
    const desc = Object.getOwnPropertyDescriptor(proto, 'userAgentData');
    assert.strictEqual(typeof desc.get, 'function', 'the prototype getter is what is patched');
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

test('it touches no WebAuthn API — the passkey correction is a separate, MS-only script', () => {
    const { navigator } = run();
    assert.strictEqual(navigator.PublicKeyCredential, undefined,
                       'this script must never touch PublicKeyCredential');
    // Check the code, not the prose: the header mentions PublicKeyCredential to explain what the
    // retired shim did to it.
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
    // A page can read these, and Chrome's are both. A non-enumerable or frozen value would itself
    // be a tell, so the flags are asserted rather than left to chance.
    const { navigator } = run();
    for (const key of ['brands', 'mobile', 'platform']) {
        const d = Object.getOwnPropertyDescriptor(navigator.userAgentData, key);
        assert.strictEqual(d.enumerable, true, key + ' enumerable');
        assert.strictEqual(d.configurable, true, key + ' configurable');
    }
});

test('it leaves pdfViewerEnabled alone when there is no getter to wrap', () => {
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

test('a userAgentData without brands does not throw when the page reads it', () => {
    // `!real || !real.brands` must return early: a `&&` there would dereference undefined and the
    // getter would throw into the page.
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

test('an engine already reporting Google Chrome gets no duplicate entry', () => {
    // `!hasChrome && brands.length` - an `||` there would unshift a second "Google Chrome".
    const proto = {};
    Object.defineProperty(proto, 'userAgentData', {
        configurable: true, enumerable: true,
        get() {
            return {
                brands: [{ brand: 'Google Chrome', version: '140' }],
                mobile: false, platform: 'Linux',
            };
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
    // `uadDesc && typeof uadDesc.get === 'function'` must not evaluate the second operand when the
    // descriptor is missing - an `||` would throw there and abort the rest of the script.
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
    assert.strictEqual(typeof window.chrome.csi, 'function');
    assert.strictEqual(navigator.pdfViewerEnabled, true, 'and the pdf answer is still corrected');
});

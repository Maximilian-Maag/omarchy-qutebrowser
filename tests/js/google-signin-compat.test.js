// Tests for userscripts/google-signin-compat.js.
//
// The script exists because Google's "not secure" check reads JavaScript detection signals
// QtWebEngine lacks. These assertions are the ones that matter: the shims appear, they are
// consistent with the advertised Chromium version, and nothing is clobbered if the engine
// already provides them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'userscripts', 'google-signin-compat.js'), 'utf8');

function run(nav, win) {
  const ctx = vm.createContext({ window: win, navigator: nav, Promise });
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('it exposes window.chrome, which real Chrome has and QtWebEngine does not', () => {
  const win = { chrome: undefined };
  run({}, win);
  assert.ok(win.chrome, 'window.chrome is defined');
  assert.equal(typeof win.chrome.loadTimes, 'function');
  assert.equal(typeof win.chrome.csi, 'function');
});

test('it exposes navigator.userAgentData consistent with the advertised version', () => {
  const nav = { userAgentData: undefined };
  run(nav, {});
  const d = nav.userAgentData;
  assert.ok(d, 'userAgentData is defined');
  assert.equal(d.mobile, false);
  assert.equal(d.platform, 'Linux');
  const chromeBrand = d.brands.find((b) => b.brand === 'Google Chrome');
  assert.ok(chromeBrand, 'a Google Chrome brand is present');
  assert.match(chromeBrand.version, /^\d+$/);
  assert.equal(chromeBrand.version, SRC.match(/var MAJOR = '(\d+)'/)[1]);
});

test('getHighEntropyValues resolves with a full version matching the UA', () => {
  const nav = {};
  run(nav, {});
  const full = SRC.match(/var FULL = '([^']+)'/)[1];
  return nav.userAgentData.getHighEntropyValues(['uaFullVersion']).then((v) => {
    assert.equal(v.uaFullVersion, full);
    assert.equal(v.architecture, 'x86');
    assert.equal(v.mobile, false, 'the high-entropy object reports mobile: false');
  });
});

test('it leaves an engine that already provides these alone', () => {
  const existing = { brands: [{ brand: 'Keep', version: '1' }] };
  const win = { chrome: { loadTimes: 'sentinel' } };
  const nav = { userAgentData: existing };
  run(nav, win);
  assert.equal(win.chrome.loadTimes, 'sentinel', 'an existing chrome object is preserved');
  assert.equal(nav.userAgentData, existing, 'existing userAgentData is preserved');
});

// The guards above each have an else-branch, and asserting only the "absent" case leaves
// their mutants alive (the target scored 0.25 without these).
test('a partially-populated chrome object keeps what it has', () => {
  const win = { chrome: { runtime: 'sentinel', csi: 'sentinel' } };
  run({}, win);
  assert.equal(win.chrome.runtime, 'sentinel', 'existing runtime is kept');
  assert.equal(win.chrome.csi, 'sentinel', 'existing csi is kept');
  assert.equal(typeof win.chrome.loadTimes, 'function', 'the missing one is added');
});

test('a null chrome object is replaced, not left null', () => {
  const win = { chrome: null };
  run({}, win);
  assert.ok(win.chrome, 'chrome must end up an object');
  assert.equal(typeof win.chrome.csi, 'function');
});

test('the brand list and platform are exactly what the check reads', () => {
  const nav = {};
  run(nav, {});
  const brands = nav.userAgentData.brands.map((b) => b.brand);
  assert.ok(brands.includes('Chromium') && brands.includes('Google Chrome'),
    'both Chrome brands are advertised: ' + brands);
  const j = nav.userAgentData.toJSON();
  assert.equal(j.platform, 'Linux');
  assert.equal(j.mobile, false, 'toJSON reports mobile: false');
});

test('navigator.webdriver is reported as false', () => {
  const nav = { webdriver: true };
  run(nav, {});
  assert.equal(nav.webdriver, false, 'an automation flag is not left exposed');
});

test('a clean navigator stays clean', () => {
  const nav = {};
  run(nav, {});
  assert.notEqual(nav.webdriver, true, 'webdriver must never become true');
});

test('it reports no public-key support, so the password flow is offered instead', () => {
  const win = { PublicKeyCredential: function () {}, hello: 'x' };
  const nav = { credentials: { get() {}, create() {} } };
  run(nav, win);
  assert.equal(win.PublicKeyCredential, undefined, 'the passkey signal is gone');
  assert.equal(win.hello, 'x', 'nothing else on window is touched');
  assert.equal(nav.credentials.get, undefined, 'credentials.get is gone');
  assert.equal(nav.credentials.create, undefined, 'credentials.create is gone');
});

test('a page without any of it is left alone', () => {
  const win = {};
  const nav = {};
  run(nav, win);
  assert.equal(win.PublicKeyCredential, undefined);
  assert.equal(nav.credentials, undefined, 'an absent credentials object stays absent');
});

test('the overrides stay redefinable, so nothing is locked down for other scripts', () => {
  const win = { PublicKeyCredential: function () {} };
  const nav = { credentials: { get() {}, create() {} } };
  run(nav, win);
  // A non-configurable override would make these permanent for the whole page; the shims
  // must leave the door open. (This is also what distinguishes `configurable: true`.)
  Object.defineProperty(win, 'PublicKeyCredential', { value: 'restored', configurable: true });
  assert.equal(win.PublicKeyCredential, 'restored');
  Object.defineProperty(nav.credentials, 'get', { value: 'restored', configurable: true });
  assert.equal(nav.credentials.get, 'restored');
  Object.defineProperty(nav.credentials, 'create', { value: 'restored', configurable: true });
  assert.equal(nav.credentials.create, 'restored');
});

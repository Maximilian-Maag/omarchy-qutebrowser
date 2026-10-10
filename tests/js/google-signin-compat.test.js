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

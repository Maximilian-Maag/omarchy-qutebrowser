// Tests for userscripts/omarchy-ms-passkey-platform-probe.js — the one-answer WebAuthn fix.
//
// Context: QtWebEngine answers PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
// with false, so Microsoft's passkey page concludes there is no passkey capability and never starts
// a ceremony — it spins on "Verifying..." with no FIDO activity at all. The userscript corrects
// that single answer, with a Proxy over the engine's own method, and nothing else.
//
// The script is an IIFE, so it is evaluated whole in a node:vm sandbox with a stand-in for
// window.PublicKeyCredential. That exercises the code that actually runs, with no npm deps.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'userscripts', 'omarchy-ms-passkey-platform-probe.js'), 'utf8');

const NAME = 'isUserVerifyingPlatformAuthenticatorAvailable';

// What the engine actually provides: a native-looking method that answers false.
function engineMethod() {
    const original = function isUserVerifyingPlatformAuthenticatorAvailable() {
        calls.count += 1;
        return Promise.resolve(false);
    };
    return original;
}
const calls = { count: 0 };

function run(mutate) {
    calls.count = 0;
    const original = engineMethod();
    const pkc = { [NAME]: original };
    const window = mutate ? mutate({ pkc, original }) : { PublicKeyCredential: pkc };
    const sandbox = { window, Object, Proxy, Promise };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { pkc, original, window, sandbox };
}

test('corrects the platform-authenticator answer to true', async () => {
    const { pkc } = run();
    assert.strictEqual(await pkc[NAME](), true);
});

test('it is a drop-in replacement for the engine method, not a removal', () => {
    const { pkc, original } = run();
    const fn = pkc[NAME];
    assert.notStrictEqual(fn, original, 'the probe must be replaced');
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(fn.name, NAME, 'the replacement must keep the method name');
    assert.strictEqual(fn.length, 0, 'and its arity');
});

test('the engine method is never invoked — the answer is synthesized', async () => {
    const { pkc } = run();
    await pkc[NAME]();
    assert.strictEqual(calls.count, 0, 'the original engine method must not be called');
});

test('the property stays configurable, enumerable and writable like the engine had it', () => {
    const before = Object.getOwnPropertyDescriptor({ [NAME]: engineMethod() }, NAME);
    const { pkc } = run();
    const after = Object.getOwnPropertyDescriptor(pkc, NAME);
    assert.strictEqual(after.configurable, before.configurable);
    assert.strictEqual(after.enumerable, before.enumerable);
    assert.strictEqual(after.writable, before.writable);
});

test('it answers a fresh true for every call, asynchronously like the real one', async () => {
    const { pkc } = run();
    const first = pkc[NAME]();
    assert.strictEqual(typeof first.then, 'function', 'must return a promise');
    assert.strictEqual(await first, true);
    assert.strictEqual(await pkc[NAME](), true);
});

test('it does nothing on a page with no PublicKeyCredential', () => {
    const { window } = run(() => ({}));
    assert.strictEqual(window.PublicKeyCredential, undefined);
});

test('it does nothing if PublicKeyCredential has no such method to wrap', () => {
    const pkc = {};
    const { window } = run(() => ({ PublicKeyCredential: pkc }));
    assert.strictEqual(window.PublicKeyCredential, pkc);
    assert.strictEqual(pkc[NAME], undefined);
});

test('it never breaks the page when the property cannot be redefined', async () => {
    const frozen = Object.freeze({ [NAME]: engineMethod() });
    const { pkc } = run(() => ({ PublicKeyCredential: frozen }));
    assert.strictEqual(typeof pkc[NAME], 'function', 'the engine method survives');
    assert.strictEqual(await pkc[NAME](), false, 'and is left answering as the engine did');
});

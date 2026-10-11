// Tests for userscripts/omarchy-ms-passkey-platform-probe.js — the one-answer WebAuthn fix.
//
// Context: QtWebEngine answers PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
// with false, so Microsoft's passkey page concludes there is no passkey capability and never starts
// a ceremony — it spins on "Verifying..." with no FIDO activity at all. Correcting that single
// answer, with a Proxy over the engine's own method, makes the flow complete.
//
// The correction must be RETRIED: the engine installs PublicKeyCredential at its own pace, so a
// single document-start attempt loses the race on many loads. Measured live — the prompt appeared
// on one load and not the next, with an identical script. The race is the first test below.
//
// The script is an IIFE, so it is evaluated whole in a node:vm sandbox. That exercises the code that
// actually runs, with no npm deps.
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

function makeEnv() {
    const timers = { pending: [], cleared: [], dom: [] };
    const warned = [];
    const sandbox = {
        Object, Array, Proxy, Promise, Date,
        setInterval: function (fn, ms) {
            const id = timers.pending.length + 1;
            timers.pending.push({ id: id, fn: fn, ms: ms });
            return id;
        },
        clearInterval: function (id) { timers.cleared.push(id); },
        console: { warn: function (m) { warned.push(m); }, log: function () {} },
        document: { addEventListener: function (ev, fn) { timers.dom.push(fn); } },
    };
    sandbox.globalThis = sandbox;
    // Fire every registered interval once (simulating time passing). A real interval persists until
    // cleared, so this must not consume it - only clearInterval() removes one.
    timers.tick = function () {
        timers.pending.slice().forEach(function (t) { try { t.fn(); } catch (e) { /* recorded */ } });
    };
    timers.fireDom = function () { timers.dom.slice().forEach(function (f) { f(); }); };
    vm.createContext(sandbox);
    return { sandbox, timers, warned };
}

// Run the script with whatever window state the test wants.
function run(withPkc) {
    calls.count = 0;
    const env = makeEnv();
    const window = {};
    if (withPkc === 'engine') {
        window.PublicKeyCredential = { [NAME]: engineMethod() };
    } else if (withPkc === 'no-method') {
        window.PublicKeyCredential = {};
    }
    env.sandbox.window = window;
    vm.runInContext(SOURCE, env.sandbox);
    return Object.assign(env, { window, pkc: window.PublicKeyCredential });
}

test('corrects the platform-authenticator answer to true', async () => {
    const { pkc } = run('engine');
    assert.strictEqual(await pkc[NAME](), true);
});

test('THE RACE: corrects it even when the engine installs the API late', async () => {
    // This is the regression that made the passkey prompt appear once and then stop appearing: the
    // engine had not defined the method at document-start, and the old one-shot script gave up.
    const env = run(undefined);                       // no PublicKeyCredential at all, yet
    assert.strictEqual(env.sandbox.window.PublicKeyCredential, undefined);
    assert.ok(env.timers.pending.length > 0, 'it must arm a retry rather than give up');

    env.sandbox.window.PublicKeyCredential = { [NAME]: engineMethod() };   // the engine catches up
    env.timers.tick();

    assert.strictEqual(await env.sandbox.window.PublicKeyCredential[NAME](), true,
                       'the correction must land once the API appears');
});

test('it stops retrying once the correction has landed', () => {
    const env = run(undefined);
    env.sandbox.window.PublicKeyCredential = { [NAME]: engineMethod() };
    env.timers.tick();
    assert.deepStrictEqual(env.timers.cleared, [1], 'the retry must be cleared, not left running');
});

test('it warns instead of failing silently when the API never appears', () => {
    const env = run(undefined);
    for (let i = 0; i < 200; i++) { env.timers.tick(); }
    assert.ok(env.warned.some(w => w.indexOf(NAME) !== -1),
              'a silent no-op is what made this look flaky; it must say so');
});

test('it is a drop-in replacement for the engine method, not a removal', () => {
    const { pkc, window } = run('engine');
    const fn = pkc[NAME];
    assert.notStrictEqual(fn, window.PublicKeyCredential[NAME] && undefined);
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(fn.name, NAME, 'the replacement must keep the method name');
    assert.strictEqual(fn.length, 0, 'and its arity');
});

test('the engine method is never invoked — the answer is synthesized', async () => {
    const { pkc } = run('engine');
    await pkc[NAME]();
    assert.strictEqual(calls.count, 0, 'the original engine method must not be called');
});

test('the property stays configurable, enumerable and writable like the engine had it', () => {
    const before = Object.getOwnPropertyDescriptor({ [NAME]: engineMethod() }, NAME);
    const { pkc } = run('engine');
    const after = Object.getOwnPropertyDescriptor(pkc, NAME);
    assert.strictEqual(after.configurable, before.configurable);
    assert.strictEqual(after.enumerable, before.enumerable);
    assert.strictEqual(after.writable, before.writable);
});

test('it answers a fresh true for every call, asynchronously like the real one', async () => {
    const { pkc } = run('engine');
    const first = pkc[NAME]();
    assert.strictEqual(typeof first.then, 'function', 'must return a promise');
    assert.strictEqual(await first, true);
    assert.strictEqual(await pkc[NAME](), true);
});

test('it does nothing on a page with no PublicKeyCredential', () => {
    const env = run(undefined);
    assert.strictEqual(env.sandbox.window.PublicKeyCredential, undefined);
    assert.ok(env.timers.pending.length > 0, 'but it keeps trying, in case the API arrives');
});

test('it does nothing if PublicKeyCredential has no such method to wrap', () => {
    const env = run('no-method');
    assert.strictEqual(env.pkc[NAME], undefined);
});

test('it never breaks the page when the property cannot be redefined', async () => {
    calls.count = 0;
    const env = makeEnv();
    env.sandbox.window = { PublicKeyCredential: Object.freeze({ [NAME]: engineMethod() }) };
    assert.doesNotThrow(() => vm.runInContext(SOURCE, env.sandbox));
    const pkc = env.sandbox.window.PublicKeyCredential;
    assert.strictEqual(typeof pkc[NAME], 'function', 'the engine method survives');
    assert.strictEqual(await pkc[NAME](), false, 'and is left answering as the engine did');
});

test('the retry runs every 50ms and gives up after 200 tries', () => {
    // Both constants are policy, not incidental: the interval is how fast it recovers, and the
    // limit is when it admits defeat. Pinned so neither drifts.
    const env = run(undefined);
    assert.strictEqual(env.timers.pending.length, 1, 'one retry loop');
    assert.strictEqual(env.timers.pending[0].ms, 50);
    for (let i = 0; i < 199; i++) { env.timers.tick(); }
    assert.deepStrictEqual(env.warned, [], 'still trying at 199');
    env.timers.tick();
    assert.strictEqual(env.warned.length, 1, 'and gives up at 200');
});

test('it keeps retrying when there is nothing to wrap yet — it does not report success', () => {
    // A `return true` on the missing-API path would make the script think it was done, arm no
    // retry, and silently do nothing: exactly the flakiness this whole change is about.
    for (const state of [undefined, 'no-method']) {
        const env = run(state);
        assert.ok(env.timers.pending.length > 0,
                  'must arm a retry for state=' + String(state));
    }
});

test('it keeps retrying when the property cannot be redefined (a frozen object)', () => {
    const env = makeEnv();
    env.sandbox.window = { PublicKeyCredential: Object.freeze({ [NAME]: engineMethod() }) };
    vm.runInContext(SOURCE, env.sandbox);
    assert.ok(env.timers.pending.length > 0, 'a failed patch must not be mistaken for success');
});

test('patching twice does not wrap twice (the DOM-ready path calls it again)', () => {
    const env = run(undefined);
    env.sandbox.window.PublicKeyCredential = { [NAME]: engineMethod() };
    env.timers.tick();
    const after = env.sandbox.window.PublicKeyCredential[NAME];
    env.timers.fireDom();                       // the second entry point, after success
    assert.strictEqual(env.sandbox.window.PublicKeyCredential[NAME], after,
                       'a second call must be a no-op, not a second wrap');
});

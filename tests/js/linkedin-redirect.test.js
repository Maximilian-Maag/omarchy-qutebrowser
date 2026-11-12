// Tests for userscripts/omarchy-linkedin-root-redirect.js.
//
// Context: LinkedIn's Cloudflare hard block is PATH-scoped. Measured here, https://www.linkedin.com/
// is answered with "Sorry, you have been blocked" while /login, /feed/ and /jobs/ load normally in
// the same engine on the same address, so the bare root URL is the tripwire and the login page is
// the way in. The script leaves the block page when it sees one - and does nothing at all on a page
// that is not a block page, which is what keeps the root URL's normal behaviour (the feed, once a
// session exists) intact.
//
// The script is an IIFE, so it is evaluated whole in a node:vm sandbox with stand-ins for
// `document`, `location` and `window` - the same shape as tests/js/chrome-identity.test.js.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', '..', 'userscripts', 'omarchy-linkedin-root-redirect.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

const LOGIN_URL = 'https://www.linkedin.com/login/';

// A document exactly like Cloudflare's block page: title plus body text, 4254 bytes measured live.
const BLOCK_TITLE = 'Attention Required! | Cloudflare';
const BLOCK_BODY = 'Sorry, you have been blocked You are unable to access linkedin.com';

function run({ title = BLOCK_TITLE, text = BLOCK_BODY, pathname = '/',
               readyState = 'interactive', throwOnReplace = false } = {}) {
    const replaced = [];
    const listeners = [];
    const document = {
        title,
        body: text === null ? null : { textContent: text },
        readyState,
        addEventListener(type, fn) { listeners.push({ target: 'document', type, fn }); },
    };
    const location = {
        pathname,
        replace(url) {
            if (throwOnReplace) { throw new Error('navigation blocked'); }
            replaced.push(url);
        },
    };
    const window = {
        addEventListener(type, fn) { listeners.push({ target: 'window', type, fn }); },
    };
    const sandbox = { document, location, window };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { replaced, listeners, document, location, window };
}

test('it leaves the block page for the login page', () => {
    const { replaced } = run();
    assert.deepStrictEqual(replaced, [LOGIN_URL]);
});

test('the destination is the absolute LinkedIn login URL, not a relative path', () => {
    const { replaced } = run();
    assert.strictEqual(replaced[0], 'https://www.linkedin.com/login/');
    assert.ok(replaced[0].startsWith('https://www.linkedin.com/'),
              'a relative destination would resolve against whatever path was blocked');
});

test('it does nothing on a real LinkedIn page', () => {
    // The root URL serves the feed once a session exists; redirecting that would be a bug.
    const { replaced } = run({ title: 'Feed | LinkedIn', text: 'Home My Network Jobs Messaging' });
    assert.deepStrictEqual(replaced, []);
});

test('the body marker alone is enough', () => {
    const { replaced } = run({ title: 'linkedin.com', text: BLOCK_BODY });
    assert.deepStrictEqual(replaced, [LOGIN_URL]);
});

test('the title marker alone is enough', () => {
    const { replaced } = run({ title: BLOCK_TITLE, text: 'nothing familiar in the body' });
    assert.deepStrictEqual(replaced, [LOGIN_URL]);
});

test('a block page served ON the login path is not bounced to itself', () => {
    // Without the guard this is an infinite redirect loop.
    const { replaced } = run({ pathname: '/login/' });
    assert.deepStrictEqual(replaced, []);
});

test('the loop guard covers the bare /login path too', () => {
    const { replaced } = run({ pathname: '/login' });
    assert.deepStrictEqual(replaced, []);
});

test('a blocked /feed/ redirects to the login page', () => {
    // Any path the WAF does block is given the same exit, not just the bare root.
    const { replaced } = run({ pathname: '/feed/' });
    assert.deepStrictEqual(replaced, [LOGIN_URL]);
});

test('a path that merely contains "login" later on is still redirected', () => {
    // Guards against matching the login path anywhere in the string: /checkpoint/lg/login is a real
    // LinkedIn path, and it is NOT the destination, so a blocked one must still be left.
    const { replaced } = run({ pathname: '/checkpoint/lg/login-submit' });
    assert.deepStrictEqual(replaced, [LOGIN_URL]);
});

test('it hooks DOMContentLoaded and load, and both hooks do the check', () => {
    const { listeners, replaced } = run({ readyState: 'loading' });
    const types = listeners.map(l => `${l.target}:${l.type}`);
    assert.deepStrictEqual(types, ['document:DOMContentLoaded', 'window:load']);
    assert.deepStrictEqual(replaced, [], 'nothing to do until one of them fires');
    for (const l of listeners) {
        l.fn();
    }
    assert.deepStrictEqual(replaced, [LOGIN_URL, LOGIN_URL],
                           'both hooks check; the first one that sees the block page leaves it');
});

test('a hook that fires on a normal page navigates nowhere', () => {
    const { listeners, replaced } = run({ readyState: 'loading', title: 'Feed | LinkedIn',
                                          text: 'Home My Network Jobs' });
    for (const l of listeners) {
        l.fn();
    }
    assert.deepStrictEqual(replaced, []);
});

test('it re-checks when the document is already parsed', () => {
    // A restart-restored tab arrives with the document already parsed, so the later hooks alone
    // would fire after the page has settled.
    for (const readyState of ['interactive', 'complete']) {
        const { replaced, listeners } = run({ readyState });
        assert.deepStrictEqual(replaced, [LOGIN_URL], `${readyState} should be acted on at once`);
        assert.strictEqual(listeners.length, 2, 'the hooks must still be registered');
    }
});

test('it does not act before a loading document is ready', () => {
    const { replaced } = run({ readyState: 'loading' });
    assert.deepStrictEqual(replaced, [], 'a still-loading document has no body to judge');
});

test('a body that is not there yet does not crash the script', () => {
    const { replaced } = run({ text: null });
    assert.deepStrictEqual(replaced, [LOGIN_URL], 'the title marker still applies');
    const { replaced: none } = run({ text: null, title: 'Feed | LinkedIn' });
    assert.deepStrictEqual(none, []);
});

test('a throwing location.replace never breaks the page', () => {
    // The script runs on a page it does not own; an exception must not escape into it.
    const { replaced } = run({ throwOnReplace: true });
    assert.deepStrictEqual(replaced, []);
});

test('it rewrites no browser API', () => {
    // The shim that broke sign-in touched navigator, window.chrome and PublicKeyCredential. This
    // script must stay a navigation-only fix.
    const sandbox = { document: { title: BLOCK_TITLE, body: { textContent: BLOCK_BODY },
                                  readyState: 'loading', addEventListener() {} },
                      location: { pathname: '/', replace() {} },
                      window: { addEventListener() {} } };
    sandbox.navigator = Object.create(null);
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    assert.deepStrictEqual(Object.keys(sandbox.navigator), [], 'navigator was touched');
    assert.strictEqual(sandbox.window.chrome, undefined, 'window.chrome was touched');
    assert.strictEqual(sandbox.PublicKeyCredential, undefined);
});

test('the @match scope is www.linkedin.com and nothing else', () => {
    const patterns = [...SOURCE.matchAll(/^\/\/\s*@match\s+(\S+)/gm)].map(m => m[1]);
    assert.deepStrictEqual(patterns, ['https://www.linkedin.com/*'],
                           'widening the scope would run this on sites it has no reason to touch');
});

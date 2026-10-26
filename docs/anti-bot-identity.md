# Sites that refuse this browser as a bot (stock-Chrome identity)

## Symptom

Certain sites stop working with a block or challenge page instead of content:

- **LinkedIn** — a Cloudflare interstitial / block page ("Attention Required", a Ray ID in the
  page). It is not a consent or paywall issue; the site never renders.
- **immowelt** — "We detected unusual activity from your device or network. Reasons may include:
  rapid taps or clicks, JavaScript disabled or not working, automated (bot) activity on your
  network, use of developer or inspection tools."
- **Kleinanzeigen** — the same class of managed bot-detection challenge.

## Root cause: the browser's fingerprint is not Chrome's

All three sit behind managed bot-detection — **Cloudflare** for LinkedIn, **DataDome** for
immowelt (verified: the served page contains a `dd={...}` config script and loads
`geo.captcha-delivery.com` / `ct.captcha-delivery.com`, which is DataDome's challenge) — and
they refuse qutebrowser's QtWebEngine client. The refusals are the *same problem as the
Google/Microsoft "This browser or app may not be secure" sign-in refusal*: the engine's
fingerprint differs from Chrome's, and this configuration's privacy defaults add to the
difference, so a detection suite scores the session as an automated/tampered browser.

Measured with an offscreen QtWebEngine probe (the real engine, no configuration applied). What
the page sees, versus real Chrome:

| Tell | QtWebEngine (default) | Chrome |
|---|---|---|
| `navigator.userAgent` | `…QtWebEngine/6.11.2 Chrome/140…` | no `QtWebEngine` token |
| `navigator.userAgentData.brands` | `Not=A?Brand 24, Chromium 140` | `Google Chrome, Chromium, …` |
| `window.chrome` | present but **empty** (`Object.keys` → `[]`) | `app, runtime, csi, loadTimes` |
| `navigator.plugins.length` | `0` | `5` |
| `navigator.pdfViewerEnabled` | `false` | `true` |

And from this configuration itself (the Privacy section), applied **globally**:

| Setting | Value | Why it is a tell |
|---|---|---|
| `content.canvas_reading` | `False` | a canvas that cannot be read at all is the classic automation signal |
| `content.headers.do_not_track` | `True` | DNT is a dead standard and a fingerprinting outlier |

The `QtWebEngine` token alone makes the browser a non-browser to most WAFs, and the JS tells
confirm it to the ones that run script.

> **Re-measured 2026-10-21 — the engine's own User-Agent changed underneath this.** qutebrowser
> 3.7.0 no longer inserts the QtWebEngine token into its default User-Agent. Its installed template
> (`configdata.yml`) is `Mozilla/5.0 ({os_info}) AppleWebKit/{webkit_version} (KHTML, like Gecko)
> {upstream_browser_key}/{upstream_browser_version_short} Safari/{webkit_version}` — there is no
> `{qt_key}/{qt_version}`. Measured live: `httpbin.org/user-agent` echoes
> `…Chrome/140.0.0.0 Safari/537.36` with no `QtWebEngine` token, and `navigator.userAgent` agrees
> with the header. So the first row of the table above is what the engine *used to* advertise, and
> only the client hints still say Chromium — which is why the hints, not the User-Agent, are what
> this configuration has to fix today.

## Ruled out (tested, not assumed)

- **The ad/tracker block lists do not cause the block.** Loaded every configured list into the
  **real** adblock engine (Brave's adblock-rust, the one qutebrowser uses) and probed the
  challenge and site assets: `challenges.cloudflare.com/turnstile/v0/api.js`, the site documents,
  `static.licdn.com` assets, `cdn.kleinanzeigen.de` and `img.kleinanzeigen.de` are all **allowed**.
  Only `static.cloudflareinsights.com` (Cloudflare's RUM beacon) and known trackers are blocked.
- **The hosts lists do not block the challenge.** `captcha-delivery.com`, `challenges.cloudflare.com`
  and `geo.captcha-delivery.com` are not in `blocked-hosts`. (`dfme.kleinanzeigen.de` is, from
  haGeZi Pro — that is Kleinanzeigen's own tracking endpoint, blocking it is intended.)

## The fix: a host-scoped stock-Chrome identity

On these hosts **only**, present a coherent Chrome client — the same remedy already shipped for
Google/Microsoft sign-in, extended to the bot-managed sites and factored so adding one is a single
edit in `_STOCK_CHROME_HOSTS` (`config/config.py`):

- **Request half** (`config/config.py`): User-Agent without the `QtWebEngine` token (Chromium
  version kept so the JS the site serves still matches the engine), `sec-ch-ua*` client hints that
  agree with it, `content.canvas_reading = True`, `content.headers.do_not_track = False`,
  `content.cookies.accept = "all"`.
- **JavaScript half** (`userscripts/omarchy-chrome-identity.js`, a Greasemonkey script scoped to the
  same hosts): `navigator.userAgentData` gains the `Google Chrome` brand, `window.chrome` is
  populated, `pdfViewerEnabled` reports `true`. It patches the **prototype** getter (an own
  property on `navigator` is itself the tell), deletes nothing, and touches no WebAuthn API — the
  shape that broke Google sign-in is deliberately avoided.

### A brand-list bug found while verifying

Injecting the real userscript into the real engine showed the corrected brands were
`["Google Chrome 24", "Not=A?Brand 24", "Chromium 140"]` — wrong twice: the GREASE brand was
listed first (Chrome keeps it last, and the `sec-ch-ua` header this config sends already puts it
last), and `"Google Chrome"` carried the grease version `24` instead of the engine major `140`,
because the code read `brands[0].version` and QtWebEngine lists the grease brand first. The fix
rebuilds the list as `["Google Chrome", "Chromium", "Not=A?Brand"]` with the major taken from the
`Chromium` brand. The same correction was applied to `omarchy-google-signin-chrome-identity.js`
(identical logic, same latent bug), whose test fixture had the brands in the unrepresentative
Chromium-first order that hid it — it now uses the engine's real order.

Every other site keeps the stricter privacy defaults: the identity is a per-host exception, never
a global relaxation (asserted in `tests/test_integration_config_identity.py`).

### The two halves have to name the same hosts, and nothing enforced it

`sec-ch-ua` (request half) and `navigator.userAgentData.brands` (JavaScript half) are two views of
one fact. A host with the first and not the second sends `sec-ch-ua: "Google Chrome";v="140"` while
the page reads `brands = ["Not=A?Brand", "Chromium"]` — the header and the page disagree about what
browser this is, which is exactly the inconsistency this section exists to remove. The rule above
("keep the two in step") was prose; nothing tested it.

Measured drift, now pinned in `tests/test_integration_identity_halves.py`:
`_STOCK_CHROME_HOSTS` names **12** hosts, the JavaScript identity was scoped to **7**. The gap was
the **four Microsoft sign-in hosts** (`login.microsoftonline.com`, `login.live.com`,
`login.microsoft.com`, `account.microsoft.com`) — they had always been sent the branded header and
never had the JavaScript half — plus `accounts.youtube.com`. The test fails if a host is added to
one half and not the other, or if an excused host carries no reason.

**Resolved, Microsoft side:** `userscripts/omarchy-ms-signin-chrome-identity.js` now carries the
JavaScript half for those four hosts. Its code body is byte-identical to the Google script's
(deliberately copied rather than reinvented), scoped to Microsoft hosts and held off the Google
ones by `test_regression_signin_untouched.py`. The alternative — dropping the branded `sec-ch-ua`
there — would have reduced the identity on a sign-in host instead of completing it.

**Still one-sided on purpose:** `accounts.youtube.com`. It is a `SetSID` redirect endpoint of the
Google handshake that renders no page a detector runs on, and the Google identity script is
deliberately forbidden from `youtube.com` by `test_regression_signin_untouched.py` (the author's
call: Google refuses the sign-in for even a single corrected probe). It is the only entry left in
`ALLOWED_DIVERGENCE`, with that reason.

### Verifying an identity script in the engine: keep the `@match` out of the harness

Measured the hard way. QtWebEngine parses a userscript's GreaseMonkey metadata itself and applies
its `@match` patterns as an URL filter, on top of wherever the script was injected. So injecting one
of these scripts into a harness page served from `127.0.0.1` measures **nothing**: the script is
filtered out before it runs, and every value reads exactly like the engine default — an
instrumented copy never even reached its first statement (`window.__ran` stayed `undefined`), at
both `DocumentCreation` and `DocumentReady`.

To check the *code* against the real engine, strip the `@match` lines from the source before
injecting (the `@match` scope is asserted separately, by the two tests above and
`test_regression_signin_untouched.py`). Done that way, both identity scripts and the new Microsoft
one report, in the real offscreen engine on a real origin:

`brands = ["Google Chrome:140", "Chromium:140", "Not=A?Brand:24"]`, `pdfViewerEnabled = true`,
`window.chrome.csi` a function, `userAgentData` still **not** an own property of `navigator`, and
`brands` enumerable and configurable — the Chrome-shaped answer, at either injection point.

### The User-Agent override is now redundant insurance

Because the engine's default User-Agent lost the token, the request half's per-host User-Agent
override is byte-identical to it — it changes nothing. It is kept on purpose: it costs nothing, it
is what protects these hosts if an engine update puts the token back, and
`tests/test_integration_identity_halves.py` fails if qutebrowser's default template regains
`{qt_key}` — so that day cannot arrive unnoticed. **The client hints are the half doing the work.**

## Why the fix is not verified headlessly

Managed bot-detection flags **headless** browsers regardless of identity — an offscreen
QtWebEngine is challenged even with a perfect Chrome fingerprint (measured: the DataDome
interstitial appears for both the default and the stock identity). A headless harness therefore
cannot tell a working identity from a broken one; it is a false-negative machine for this class.
The harness is only good for **reproducing** the block and for asserting the *tells* are gone.

Verification is therefore in the live browser: restart qutebrowser (a `,greasemonkey-reload` is
not enough for the request-level half to re-read config; `:config-source` re-reads config.py) and
open the site. `install.sh` links the userscript into the Greasemonkey dir.

## Residual tell

`navigator.plugins.length` is still `0` (QtWebEngine ships no plugin list). It is left alone on
purpose: a hand-built `PluginArray` is itself detectable, and a wrong one is worse than an empty
one. If a site still challenges, this is the next lever to measure — not to guess at.

## Adding a site

1. Add its host patterns to `_STOCK_CHROME_HOSTS` in `config/config.py`.
2. Add matching `@match` lines to the JavaScript half that fits it: `omarchy-chrome-identity.js` for
   a bot-managed site, `omarchy-google-signin-chrome-identity.js` or
   `omarchy-ms-signin-chrome-identity.js` for a sign-in host. Each script's scope is asserted
   separately, so a new family means a new script plus its own entry in
   `tests/test_regression_signin_untouched.py` — do not widen an existing one.
3. Update the host lists asserted in `tests/js/*identity*.test.js`,
   `tests/test_integration_config_identity.py` and that script's entry in
   `tests/test_regression_signin_untouched.py`.
4. Add the new script to `tests/mutation.json` (`tests/no-gaps` fails until every shipped source file
   is either a target or exempt with a reason) and give it a `tests/js/` suite — that is what kills
   its mutants.
5. Run `tests/test_integration_identity_halves.py`. It fails until the JavaScript half covers the
   new host, or the host is recorded in `ALLOWED_DIVERGENCE` with the reason it is one-sided — which
   is the point: a host cannot be half-configured silently.

# LinkedIn's Cloudflare hard block is PATH-scoped (the bare root URL)

Companion to `docs/anti-bot-identity.md`. That doc covers the stock-Chrome identity fix for the
managed-bot-detection **challenge**. This one records a case where the identity is fully applied and
the site **still** hard-blocks the bare root URL - and what actually gets you in.

## Symptom

`https://www.linkedin.com/` in the live qutebrowser: window title `Attention Required! | Cloudflare`;
the body is Cloudflare's **hard block**, not a challenge:

> Sorry, you have been blocked — You are unable to access linkedin.com … The action you just
> performed triggered the security solution. (Ray `a4eb6ea29e4531bc`)

That is the WAF/firewall block (1020-style), decided **before** the page's JavaScript runs — it is
not the "Just a moment" managed challenge `omarchy-chrome-identity.js` was built to clear.

## What is NOT the cause (all measured, 2026-11-04, on the A1/Vienna egress)

The earlier version of this document concluded "the identity is not the lever, so use a Chromium
browser for this one site". That conclusion was too broad. What the measurements actually support:

| ruled out | measurement |
|---|---|
| IP reputation | `curl https://www.linkedin.com/` from this machine gets **HTTP/2 200** and the real page (`LinkedIn: Log In or Sign Up`), on the same address the browser is blocked from. |
| request headers | the same `curl` with the identity's exact header set (Chrome UA, `sec-ch-ua` with `Google Chrome`, `sec-fetch-*`, the engine's `accept`/`accept-encoding`) is **200**. Claiming Chrome over a non-Chrome TLS stack is not what trips it. |
| cookies / session / profile state | a **fresh, cookieless** QtWebEngine profile is served the block page too. |
| our config, the identity, the userscript | a **bare** engine (no config, no userscript) is blocked; adding the Chrome client hints changes nothing. `docs/anti-bot-identity.md`'s half is correct and irrelevant here. |
| QUIC / HTTP-3 | the engine's `/cdn-cgi/trace` says `http=http/2`; `--disable-quic` changes nothing. |
| IPv6 | no IPv6 route on this machine; both clients use the same IPv4 path. |
| a Chrome-shaped TLS/H2 surface being missing | the engine's ClientHello has Chrome's 16 ciphers, the `X25519MLKEM768` key share, GREASE, ECH and ALPS extensions, and its HTTP/2 preface is Chrome's exactly (`SETTINGS 1:65536;2:0;4:6291456;6:262144`, `WINDOW_UPDATE 15663105`, priority frame weight 256). |

So the block tracks something about the QtWebEngine client that is **below the JavaScript layer and
not the surfaces measured above** — but it is **not** "LinkedIn blocks this browser everywhere".

## The actual finding: the block is path-scoped

The same engine, same address, fresh profile, one request each:

| URL | result |
|---|---|
| `https://www.linkedin.com/` | **blocked** — `Attention Required! | Cloudflare` |
| `https://www.linkedin.com/login` | loads — `LinkedIn Login, Einloggen | LinkedIn` |
| `https://www.linkedin.com/uas/login` | loads (redirects to `/login`) |
| `https://www.linkedin.com/feed/` | loads (redirects to `/login?session_redirect=…`) |
| `https://www.linkedin.com/jobs/` | loads — the real jobs page |
| `https://www.linkedin.com/in/` | loads LinkedIn's normal `authwall` (logged out) |

Reproduced twice for the root URL and twice for `/login`; deterministic. The tripwire is the **bare
root URL**, not the host and not the engine's whole fingerprint.

## The fix

`userscripts/omarchy-linkedin-root-redirect.js` (installed by `install.sh`): when the document *is*
Cloudflare's block page and we are not already on a `/login` path, navigate to
`https://www.linkedin.com/login/`. On any real LinkedIn page it does nothing — the root URL serves
the feed normally once a session exists, and that must not be redirected.

Deliberately small and safe, because this runs on a host that also hosts an auth flow:

- no browser API is touched (the whole `FORBIDDEN` list in
  `tests/test_regression_signin_untouched.py` holds it, plus a dedicated class there for the scope);
- the only URL it can navigate to is on `linkedin.com`, and its `@match` is
  `https://www.linkedin.com/*` and nothing else;
- `/login` itself is excluded, so a block page served *on* the login path cannot bounce forever;
- the block page is recognised on **either** marker independently (the title
  `Attention Required` or the body `you have been blocked`).

Verified end to end against the real engine and the real URL
(`tests/e2e/test_linkedin_redirect_e2e.sh`): the run meets the block page at the root
(`"blocked": true`, title `Attention Required! | Cloudflare`), the script moves the browser to
`https://www.linkedin.com/login/`, the real login page renders there, and a second navigation to
`/login` is left alone.

## Re-testing

- After any qutebrowser/QtWebEngine upgrade, the engine's signature may shift again; if `/login`
  starts being blocked too, this fix stops helping and the below-JS question is back.
- If Cloudflare relaxes LinkedIn's managed rule, the root URL loads normally and the script does
  nothing — the e2e run reports that as a note (nothing to escape) rather than a failure.

## Tooling notes (still true, still cost time)

- `:jseval --file` silently no-ops over IPC: `qutebrowser --target tab ':jseval --world main --file
  /tmp/probe.js'` answers "Opening in existing instance" and never runs. Use the short `-f` form, or
  inline code (a `;` breaks the send — qutebrowser's command separator).
- Reproduce and read this class of block **without touching the live browser**: an offscreen
  QtWebEngine with throwaway XDG dirs (so it does not collide with the running profile) is served
  the same block page. `tests/e2e/linkedin_redirect_driver.py` is the working example, and reading
  results back over the page's own `console.log` beats `document.title`, which a document that is
  navigated away from cannot give you.
- `QTWEBENGINE_CHROMIUM_FLAGS` is whitespace-split by the engine, so a `--host-resolver-rules=MAP
  a:443 b:8443` rule (which contains a space) cannot be expressed there; a local capture listener
  needs a hostname that already resolves to `127.0.0.1`.

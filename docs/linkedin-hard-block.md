# LinkedIn's residual Cloudflare hard block (identity applied)

Companion to `docs/anti-bot-identity.md`. That doc covers the stock-Chrome identity fix for the
managed-bot-detection **challenge**. This one records a case where the identity is fully applied
and the site **still** hard-blocks — so the fix is not the lever.

## Symptom (measured 2026-10-22)

`https://www.linkedin.com/` in the live qutebrowser: window title `Attention Required! | Cloudflare`;
the body is Cloudflare's **hard block**, not a challenge:

> Sorry, you have been blocked — You are unable to access linkedin.com … The action you just
> performed triggered the security solution. (Ray `a4eb6ea29e4531bc`)

That is the WAF/firewall block (1020-style), decided **before** the page's JavaScript runs — it is
not the "Just a moment" managed challenge `omarchy-chrome-identity.js` was built to clear.

## The identity is NOT the cause (measured live, not inferred)

A main-world probe in the running browser's LinkedIn tab — `:jseval --world main`, result written to
`document.title` and read back via `hyprctl` — shows the identity fully applied:

| tell | live value |
|---|---|
| `navigator.userAgent` | `…Chrome/140.0.0.0 Safari/537.36` (no `QtWebEngine` token) |
| `navigator.userAgentData.brands` | `["Google Chrome 140","Chromium 140","Not=A?Brand 24"]` |
| `window.chrome` | `["app","runtime","csi","loadTimes"]` |
| `navigator.pdfViewerEnabled` | `true` |
| `navigator.webdriver` | `false` |
| canvas readable | `true` |
| `userAgentData` an own prop of `navigator` | `false` (prototype patch, correct) |

Every tell the request half + the JavaScript half correct is correct on the live page. So the block
is not the fingerprint tells this repo fixes.

## Discriminator: same machine, same public IP, different engine

- The machine's egress IP is `185.198.142.110` (TeleData, DE).
- A **real Chromium** browser on that **same machine / same IP** loads
  `https://www.linkedin.com/` fine — title `LinkedIn: Log In or Sign Up`, full page.
- qutebrowser (QtWebEngine) on that same IP is hard-blocked.

⇒ The block is **not** IP reputation and **not** the JavaScript fingerprint; it tracks the
**QtWebEngine client below JavaScript** — its TLS (JA3/JA4) and HTTP/2 fingerprint and its header
order — which no config value or userscript can change. (Not directly observable from the page, but
the same-IP/different-engine result places the difference there.)

Cookies/session are ruled out too: the profile's cookie store holds **no** `linkedin.com` rows, and
the no-cookie Chromium loads the page.

## What this means

Nothing in `config/config.py` or the identity userscripts needs changing here — that half is already
correct and now verified on the live page. The residual block is out of reach for this class of fix.
For LinkedIn the options are:

- use a Chromium-family browser for that one site (Chromium is not installed on this machine today),
  or
- accept the block in qutebrowser.

Re-test after any qutebrowser/QtWebEngine upgrade: if the engine's TLS/HTTP2 signature moves closer
to Chrome's, this may clear on its own; and if Cloudflare relaxes LinkedIn's managed rule, likewise.

## Tooling note: `:jseval --file` silently no-ops over IPC

Sending `:jseval --world main --file /tmp/probe.js` to the running instance answers
"Opening in existing instance" but the code never runs — the target tab's title does not change, in
**either** argument order. What works, measured:

- inline code: `qutebrowser --target tab ':jseval --world main document.title="x"'` (spaces are fine), and
- base64 + eval: `qutebrowser --target tab ":jseval --world main eval(atob(\"$B64\"))"` — the reliable
  form for a multi-statement probe.

Read the result back from the window title (`hyprctl clients -j`), which avoids the clipboard.

# Scoping: a real inline passkey autofill dropdown

Status: **not built — scoped**. The modal chooser (engine patch 2) already lets a conditional
sign-in complete, so this is a presentation improvement, not a fix for a broken flow. This document
exists so the decision to spend the time (or not) can be made from facts rather than a guess.

## What "the gap" actually is

A relying party may call `navigator.credentials.get({ mediation: "conditional" })`. Chromium marks
that request `UIPresentation::kAutofill` and expects the *browser* to show inline suggestions
("Sign in with a passkey") anchored to the focused username field — non-modal, shown only once the
user focuses the field, dismissed on blur/Escape. QtWebEngine implements none of that:

- `AuthenticatorRequestDialogControllerPrivate::setCurrentState()` returns early for `kAutofill`
  (line ~115 of `authenticator_request_dialog_controller.cpp`), so no dialog is ever created and
  the page waits forever — the hang patch 2 removes by presenting the request as `kModal`.
- `AutofillClientQt::GetAutofillSuggestions` is `NOTIMPLEMENTED()` (`core/autofill_client_qt.cpp`) —
  Qt has no autofill *popup* component at all, so there is nothing to hand these suggestions to.

So the real work is: build an autofill popup for QtWebEngine and feed it the WebAuthn request.
Chromium's own autofill popup does not exist in Qt, which is why this is a UI project and not a
one-line change.

## Route A — reuse Chromium's autofill popup pipeline

Implement `AutofillClientQt::GetAutofillSuggestions` and wire an `AutofillPopupController`-backed
popup. The popup would be a new native widget bridged into the render-view pipeline.

- Touches: `core/autofill_client_qt.{h,cpp}`, `core/render_widget_host_view_qt.{h,cpp}` (anchor
  geometry), a new `AutofillPopupController`/delegate bridge, plus the WebAuthn request feeding
  suggestions into the popup.
- Verdict: **heaviest** and the most coupled to Chromium interfaces that Qt deliberately stubs.
  High anchor-drift surface. Not recommended.

## Route B — a Qt-native suggestion popup fed by the WebAuthn request (recommended, if built)

Keep the popup in Qt, anchored to the focused field's geometry fetched from the page; feed it from
the WebAuthn request. Smaller, no Chromium autofill dependency.

Files, in dependency order:

1. `core/authenticator_request_dialog_controller_p.h/.cpp` — stop returning early for `kAutofill`;
   add an autofill path that emits a **new** signal (suggestions + anchored geometry) instead of
   creating the modal dialog. Keep `kModal` for everything else.
2. `core/authenticator_request_client_delegate_qt.h/.cpp` — implement the interface members Qt
   leaves empty and that a dropdown needs: `SetCredentialIdFilter`, `SetCredentialTypes`,
   `SetHints`, `SetUserEntityForMakeCredentialRequest`; store them and route `SelectAccount` for the
   autofill path to the same `onSelectAccount` callback the modal path uses.
3. `core/web_contents_delegate_qt.{h,cpp}` + `api/profile_adapter*.{h,cpp}` — plumb a
   "show autofill suggestions" call, carrying the request and the anchor rect, to the adapter
   client (mirroring `showWebAuthDialog`).
4. Public API (`api/qwebenginepage.*`, `api/qwebenginewebauthuxrequest.*`, and the quick variant) —
   a new signal (e.g. `webAuthUxRequested` already exists; add a presentation flag or a sibling
   `webAuthAutofillRequested`) plus a way to report the anchor geometry. **This is a public-API
   addition**, so it is a bigger, more reviewable patch than the current two and its anchors are
   more likely to move between Qt releases.
5. A new `AutofillPopup` widget (a `QWidget`/`QQuickItem`): non-modal frameless list anchored to the
   rect; shown on focus, dismissed on blur/Escape; choosing an entry calls `setSelectedAccount`.
   Plus Rust-free geometry handling and a `QWebChannel`-free anchor query
   (`runJavaScript("document.activeElement.getBoundingClientRect()…")`).
6. Plugin side (`config/omarchy_webauthn.py`) — connect the new signal and show the popup instead of
   (or in addition to) the modal, with the same defensive wrapping as the existing handler.

## Cost and risks

- Plumbing + API (steps 1–4): ~2–3 days. Popup widget + focus/blur/dismiss (step 5): ~1–2 days.
  API design, docs, and tests (unit + the offscreen e2e that already exists): ~1 day.
- Rebuild: incremental `makepkg -e --noprepare --nocheck -d -f` (the same command
  `build-patched-engine.sh` uses) plus install, which **needs root** — a step only you can run.
- Biggest risk: steps 3–4 touch Qt's *public* API, not just internal files. That widens the patch,
  makes it harder to keep reviewable, and raises the chance that `apply-webauthn-patch.py --check`
  reports `drift` on the next Qt upgrade (the guard added in 1.17.42 will catch that loudly).
- Payoff: the modal chooser becomes an inline, non-modal list. Function is identical.

## Recommendation

Accepted, not built, **unless the modal chooser's intrusiveness bites in practice** (e.g. a site
calls conditional `get()` on load and the modal pops unprompted). If that happens, Route B is the
route; Route A is not worth its coupling. If built, the change should stay behind the existing
`--check`/`build-patched-engine.sh` guard so an unpatched or drifted build can never ship silently.

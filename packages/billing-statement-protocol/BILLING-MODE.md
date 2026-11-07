# Preserving the displayed billing action (protocol 1.0.0)

Package 5.9.0 adds optional `billing_context` to frozen credit, recurring add-on,
subscription Checkout and Portal action bodies. Existing fields, paths, prices
and response shapes remain unchanged. Generated JSON Schema and OpenAPI accept
the optional string (1–2,048 characters). Consumers opt in on the **read** with
`x-uoa-billing-mode-protocol: 1.0.0`. An unrecognized or repeated header is refused.
No header means the historical shape, without an extra field.

The value is an opaque UOA-authenticated binding, not a browser-authored body or
credential. It binds the original subject, product app key, exact action endpoint,
server-authored body, Stripe account/mode, team mode revision and a ten-minute
expiry. A team may change mode only through platform-superadmin Admin controls.
Neither a product member nor a token can select a mode. The token grants no
identity or billing-manager authority; every action still needs the product's
own key, a fresh exact-endpoint actor and current UOA authority.

## Browser and backend handoff

1. The product backend negotiates the read and returns UOA's displayed action
   and its original `billing_context` to the browser.
2. When the person clicks, the browser sends only the product's allowed action/
   offer/option identifier, the **original** opaque context and any independently
   permitted input, such as fixed purchased seats. It cannot choose UOA URLs,
   prices, account IDs, subject IDs or an arbitrary UOA body.
3. The backend validates the identifier against its fixed action/path allowlist
   and its authenticated current subject. It may fetch current UOA actions to
   validate availability, but must preserve the browser's original context. It
   forwards the validated server-authored body with that original context and a
   fresh endpoint-bound actor. It must never copy a replacement context from the
   new read into this mutation.
4. If the displayed context is missing, expired or stale, stop. Refresh the
   displayed actions and require another deliberate click. Never silently
   negotiate a new binding, retry as unbound, or initiate money from the refresh.

Transport retries of an initiated operation retain the original context and
actor `jti`. Captured durable financial objects keep their original account and
mode for recovery, webhook processing, refunds and invoice work. An expired
display token does not authorize a replacement payment. Existing pending
payments remain visible and recoverable through their original persisted state.

## Refusals

The production response remains `{ "error": "Request failed", "code": "…" }`.
These codes do not mean the person should be signed out:

| HTTP | Code | Consumer behavior |
| --- | --- | --- |
| 409 | `BILLING_CONTEXT_REQUIRED` | Preserve the session; obtain supported displayed actions and require a new click. Never upgrade the pending unbound request into bound work. |
| 409 | `BILLING_CONTEXT_STALE` | The display expired or its account/mode revision changed. Refresh and require a new click; do not replay against the new mode. |
| 400 | `BILLING_CONTEXT_INVALID` | Refuse a malformed, modified, cross-subject/app/endpoint/body binding. Do not forward an alternative body or bypass the binding. |

For compatibility, an unbound money action is eligible only on an untouched
default-live team (revision zero). Once an operator has changed the team's mode,
including a later return to live, its new money actions require the original
displayed binding. Old consumers retain balance/history reads but receive disabled
money actions for such teams. They are never automatically upgraded on mutation.
Cancellation confirmations already carry their own opaque account-bound intent;
those exact persisted intents remain authoritative and are not rebound by this
display protocol. Turning off automatic top-up remains a revocation of future
consent, with its original account-bound context; it cannot move an old attempt.

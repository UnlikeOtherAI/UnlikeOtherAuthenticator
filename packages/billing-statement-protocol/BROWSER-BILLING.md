# Prepaid cloud browser billing

Browser protocol 1.0.0 uses a dedicated `BROWSER_RUNTIME` app key. It cannot
replace an entitlement, checkout, SMS or Voice key. Customer browsers never
receive this key or the Browserbase key.

## Configure the service

A UOA system superuser opens **Billing → Nessie → Cloud browsers**. Publish the
Browserbase project ID, the account's verified USD hourly price, the provider
evidence URL and a review expiry. Browserbase bills started minutes. Each version fixes a one-minute minimum and a 10% markup. Existing
sessions retain the version reserved at admission. An expired or retired
version cannot authorise another dispatch. Nessie absorbs Browserbase's fixed monthly subscription fee. Customer billing
uses the verified minute rate plus 10%, including minutes within the provider's
monthly allowance; no fixed subscription fee is allocated to customers.

Create a separate **Browser runtime** app key for Nessie's server. Configure its
existing actor issuer, public signing key and audience in the same way as other
billing app keys. Store the secret in `UOA_BROWSER_RUNTIME_APP_KEY_NESSIE` on both
the API and worker. Rotate by installing a replacement before revoking the old
key; the replacement may settle the service's earlier reservations.

## Reserve, claim and dispatch

`POST /billing/v1/browser/tariff` and `/reservations` require a fresh signed human
actor whose audience is the exact endpoint. Reservations bind the original
subject, organisation, selected team, provider project, maximum duration and
run budget context. A live-mode prepaid wallet and sufficient shared credits
are required. Sandbox credits never fund real browser time. The bound includes
one extra minute for provider timing; it is a hold, not the customer's charge.

Persist the dispatch ID before reserving. Claim it through `/reservations/claim`
exactly once. Only a response with `can_dispatch: true` permits the provider
create call. Losing a claim response does not permit another claim to create.
Persist a local one-shot marker before POSTing to Browserbase and include the
dispatch ID as `userMetadata.nessieBrowserId`. Disable proxies, recordings,
provider logs and CAPTCHA solving; enforce the reserved timeout at Browserbase.

## Recovery and final usage

The runtime fetches the original provider session's terminal receipt. Send only
session/project/dispatch IDs, status, timestamps and proxy bytes to
`/reservations/receipt`. UOA computes the charge from its frozen tariff and
commits the paid liability, debit and hold release together. Repeating the same
receipt returns the same result. A conflicting receipt cannot replace evidence
or charge twice. Later human logout or membership revocation does not erase an
incurred charge; it prevents new dispatch claims.

Lost create responses require lookup by the original dispatch metadata. Unknown
usage retains the hold. Unexpected proxy bytes or duration beyond the reserved
bound enter reconciliation. The operator sees pending and reconciliation
counts on the Cloud browsers tab. Billing → Usage exceptions
records a current superuser decision, caps customer collection at the original
hold and retains any excess as an explicit waiver. Browser timing and proxy
evidence remain immutable. A retry observes the settled decision without a
second debit. Recovery must continue reading the original
provider session; never cancel the pending record just to unblock another one.

`/reservations/release` accepts only runtime-held durable proof that no session
was created: no provider dispatch, or a definite 400/401/403/404/422/429 rejection
of the create request. A timeout, 5xx, empty lookup or malformed successful
response is not that proof. The cancellation tombstone also prevents a delayed
reservation request from recreating a released hold.

## Customer evidence

The existing Credits history identifies cloud browser time, billed minutes,
credits and the original user. Organisation totals include these debits. No
URL, page content, cookie, browser credential or captured screen enters the
billing protocol. Published schemas and OpenAPI are under
`schema/billing-browser-v1.json` and `openapi/billing-browser-v1.openapi.json`.

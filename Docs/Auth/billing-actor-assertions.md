# Billing actor assertions — the endpoint audience contract

Every billing endpoint that acts for a named human authenticates two independent
things:

1. **Which product is calling** — the `X-UOA-App-Key` credential
   (`uoa_app_…`), one revocable key per product, verified against a peppered
   HMAC digest.
2. **Which human it is acting for** — the `X-UOA-Actor` header, a short-lived
   RS256 assertion the relying party signs with the key it registered against
   that credential.

This document defines the audience half of (2): **an actor assertion names the
exact endpoint it is presented to, and UOA verifies that per endpoint.**

## The rule

`aud` MUST be this deployment's public base URL joined with the exact request
path:

```
aud = ${PUBLIC_BASE_URL}${request path}
```

So a statement call carries
`https://authentication.unlikeotherai.com/billing/v2/customer-statement`, and a
top-up call carries
`https://authentication.unlikeotherai.com/billing/v1/credits/top-up-checkout`.
There is no single audience that works for every endpoint, and there is not
meant to be.

A relying party mints one assertion per request already — the TTL is 60 seconds
and `jti` is required — so this costs nothing beyond building the string from
the URL it is about to call.

### Why it exists

Before this rule the audience was verified against `BillingAppKey.actorAudience`,
and registration pinned that column to the single constant
`${PUBLIC_BASE_URL}/billing/v1/effective-tariff` for every key. The comparison
therefore passed for every endpoint alike: the claim was checked but identified
nothing.

The concrete exposure was **replay across privilege levels inside the TTL**. An
assertion minted for a read — `/billing/v1/credits`, a statement, a subscription
summary — was, byte for byte, a valid assertion for
`/billing/v1/credits/top-up-checkout`, `/billing/v1/cancellation/confirm`, or
`/billing/v1/stripe/portal-session`. Anything that saw one read assertion within
60 seconds of its issue (a log line, a proxy, a crash dump, a side channel in
the relying party) held a credential for the mutating endpoints too. Binding the
audience to the path closes that: an assertion is now spendable only where it
was minted to be spent.

## What UOA does

`verifyBillingActor` (`API/src/services/billing-actor.service.ts`) takes the
endpoint the caller actually reached, threaded from the route — the only layer
that knows the path — and not inferred by any service. Order matters:

1. Verify the RS256 signature against the credential's registered public JWK and
   `kid`, and the issuer against the credential's registered `actorIssuer`.
2. Verify the TTL bounds, and that `sub` / `product` / `organisation_id` /
   `team_id` match the request body.
3. **Then** compare `aud` against the endpoint audience.

The audience check runs after the signature so an unauthenticated caller cannot
use the distinct error code as an oracle. `aud` must be a JSON string; an array
audience is refused even if it contains the right value.

Failures:

| Condition | Status | Code |
| --- | --- | --- |
| Bad signature, issuer, TTL, or subject binding | 401 | `INVALID_BILLING_ACTOR` |
| Signature valid, audience is not this endpoint | 401 | `BILLING_ACTOR_AUDIENCE_MISMATCH` |
| Header absent, duplicated, or empty | 401 | `MISSING_BILLING_ACTOR` |

## Transition: `BILLING_ACTOR_AUDIENCE_MODE`

Products shipped before this rule pin the one legacy audience, so enforcement is
gated by a deployment setting.

| Value | Endpoint audience | Registered legacy audience | Anything else |
| --- | --- | --- | --- |
| `warn` (default) | accepted | accepted, and logged | refused |
| `enforce` | accepted | refused | refused |

The legacy audience is only ever the value stored on the calling credential, and
only when it is one of this deployment's own `/billing/` URLs — a credential row
naming a foreign origin is refused in both modes.

Each legacy acceptance logs at `warn` with the endpoint, the presented audience,
the audience that was expected, the product, and the app key id. That is the
operator's worklist.

### Flipping to enforce

1. Leave the default (`warn`) while products still mint one audience.
2. Watch for the log message
   `billing actor assertion used the legacy constant audience instead of the endpoint audience`.
   Every distinct `product` / `app_key_id` in it is a relying party that has not
   moved.
3. Ship the per-endpoint audience in each product. It is safe to deploy at any
   time — the endpoint audience is accepted in **both** modes, so products can
   migrate one at a time with no coordination.
4. When the log has been silent across a full billing cycle, set
   `BILLING_ACTOR_AUDIENCE_MODE=enforce` in the Cloud Run service configuration
   and redeploy. Nothing else changes; the variable is read per request through
   `getBillingActorAudienceMode()`.
5. To roll back, set it to `warn` (or remove it) and redeploy.

Enforcing while a product still sends the legacy audience makes that product's
billing calls fail with 401 `BILLING_ACTOR_AUDIENCE_MISMATCH`. That is the
intended behaviour, and it is why the default is `warn`.

## The endpoint list

The 19 actor-authenticated endpoints are declared once, in
`API/src/services/billing-actor-audience.service.ts`
(`BILLING_ACTOR_ENDPOINTS`), so the set is reviewable in one place. A unit test
asserts every declared entry is a POST route the server actually registers — a
typo there would mint an audience no product could produce and would 401 that
endpoint outright once enforcing.

```
/billing/v1/effective-tariff
/billing/v1/service-access/confirm
/billing/v1/customer-statement
/billing/v2/customer-statement
/billing/v1/credits
/billing/v1/credits/top-up-checkout
/billing/v1/credits/auto-top-up/setup
/billing/v1/credits/auto-top-up/update
/billing/v1/credits/auto-top-up/disable
/billing/v1/credits/auto-top-up/recover
/billing/v1/recurring-addons
/billing/v1/recurring-addons/checkout
/billing/v1/recurring-addons/cancellation/preview
/billing/v1/recurring-addons/cancellation/confirm
/billing/v1/cancellation/preview
/billing/v1/cancellation/confirm
/billing/v1/stripe/checkout-session
/billing/v1/stripe/subscription-summary
/billing/v1/stripe/portal-session
```

Adding an actor-authenticated endpoint means adding it to that list and passing
it from the route; `endpoint` is a required parameter, so the compiler refuses a
route that forgets.

One endpoint delegates internally: `/billing/v1/credits/auto-top-up/recover`
calls the setup service. The assertion is re-verified against the **recover**
audience, because that is the endpoint the caller presented it to — never
against the endpoint being delegated to.

## What this does not change

- The app key, the actor signature, the issuer binding, the 60-second TTL, the
  `tv` credential-epoch check, and the re-resolution of ACTIVE org/team
  membership are all unchanged.
- `BillingAppKey.actorAudience` is still written at registration and still
  pinned to the effective-tariff URL. Under this contract it is the transitional
  legacy value only; it is unused when the deployment enforces.

## Related

- `API/src/services/billing-actor.service.ts` — verification
- `API/src/services/billing-actor-audience.service.ts` — audience derivation, mode, endpoint list
- `API/tests/unit/billing-actor.service.test.ts`, `API/tests/unit/billing-actor-audience.test.ts`
- `Docs/Requirements/billing-tariffs.md` — the wider billing contract
- `Docs/deploy.md` — where the environment variable is set

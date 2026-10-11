# SMS operator setup and regional provider evidence

The SMS runtime is off by default. This guide describes configuration, not proof
that a live number, charge or message has succeeded. The underlying financial
contract is [sms-pricing-and-prepaid.md](sms-pricing-and-prepaid.md).

## 1. Purpose-bound product keys

A current platform SUPERUSER opens **Admin → Billing → Nessie → App keys** and
issues three distinct named keys for the active `nessie` billing service:

| Purpose | Install in Nessie | Authority |
| --- | --- | --- |
| `entitlement` | `UOA_SMS_ENTITLEMENT_APP_KEY_NESSIE` | Human quotes, quote verification, number status and prepaid reservations |
| `customer_lifecycle` | `UOA_SMS_CUSTOMER_LIFECYCLE_APP_KEY_NESSIE` | Number Checkout, standing inbound funds and responsible-agent grants |
| `sms_runtime` | `UOA_SMS_RUNTIME_APP_KEY_NESSIE` | Machine attach/end/recovery, claim/receipt/release, delegated quote/reserve and grant/standing-fund recovery |

The equivalent audited API is
`POST /internal/admin/billing/services/:serviceId/app-keys`. Supply `purpose`,
`name`, `actor_issuer`, `actor_audience`, `actor_public_jwk`,
`checkout_return_origins`, and optional `expires_at`. Bind the exact existing
Nessie actor issuer and public half of its dedicated RS256 actor signing key;
do not generate an unrelated replacement or copy its private JWK to UOA.

Key registration retains the canonical audience
`https://authentication.unlikeotherai.com/billing/v1/effective-tariff`.
Individual SMS requests nevertheless require fresh endpoint-specific actor
assertions; registration is not permission to send that legacy audience on SMS
requests. Lifecycle keys require the approved Nessie return origin
`https://app.nessie.works`. Entitlement and SMS runtime keys require an empty
return-origin list. Key plaintext is revealed once and belongs only in the
approved deployment secret channel, with API and worker configuration aligned.
An ordinary Ledger runtime key is not an SMS runtime key.

## 2. Twilio evidence regions

UOA reads provider evidence; it does not send SMS or verify Twilio webhooks.
There is no UOA Twilio Auth Token requirement. Nessie separately needs the Auth
Token belonging to the webhook's messaging region.

| UOA environment | Meaning |
| --- | --- |
| `BILLING_SMS_TWILIO_ACCOUNT_SID` | The exact account that owns the numbers and messages |
| `BILLING_SMS_TWILIO_API_KEY_SID` / `BILLING_SMS_TWILIO_API_KEY_SECRET` | US1 key pair for global number availability/ownership and Pricing APIs |
| `BILLING_SMS_TWILIO_REGION` | `us1` (default) or `ie1`; chooses Message and basic Lookup evidence region |
| `BILLING_SMS_TWILIO_IE1_API_KEY_SID` / `BILLING_SMS_TWILIO_IE1_API_KEY_SECRET` | Separate IE1 key pair, mandatory when region is `ie1` |

IE1 Message reads, inbound metadata recovery and charge receipts use
`api.dublin.ie1.twilio.com`. Basic Lookup uses
`lookups.dublin.ie1.twilio.com` without paid enrichment fields. US1 inventory and
Pricing reads keep `api.twilio.com` and `pricing.twilio.com` and the US1 pair.
Missing/invalid IE1 configuration and failed IE1 requests fail closed; they never
retry a US1 Message or Lookup request. No caller-supplied provider host is accepted.

Credentials are region-specific. A US1 key cannot serve as the IE1 key. Twilio
numbers must separately be configured for IE1 messaging and regional webhooks
through the product's provisioning flow; setting UOA's evidence region does not
move a number. All products using this UOA provider must agree on the configured
message region. Historical records do not store region: before changing an
already-active deployment's region, reconcile its outstanding messages, receipts
and liabilities in the original region. This configuration is not a migration
mechanism for mixed-region historical traffic.

Official references checked 11 October 2026:
- https://www.twilio.com/docs/global-infrastructure/messaging-api-with-twilio-regions
- https://www.twilio.com/docs/lookup/using-lookup-with-twilio-regions
- https://www.twilio.com/docs/global-infrastructure/manage-regional-api-credentials

## 3. Commercial and evidence prerequisites

Select an explicit commercial mode and supply its private settings. Neither mode
supplies a percentage or price default:

- `UOA_SMS_COMMERCIAL_POLICY_VERSION`: a stable version identifier, 1–80 ASCII
  letters, digits, underscores or hyphens, required for both modes.
- `UOA_SMS_PRICING_MODE=provider_markup`: uniform markup on provider number rental
  and the complete SMS charge (transport, carrier and processing/failure charges
  included in the verified total). `UOA_SMS_PROVIDER_MARKUP_BPS` is the explicit
  nonnegative integer markup in basis points, at most six digits. There is no
  fixed monthly increment in this mode. Country is not a commercial-policy input.
- `UOA_SMS_PRICING_MODE=legacy` (the compatibility default): preserve the existing
  `UOA_SMS_MONTHLY_FEE_EUR` fixed monthly increment and
  `UOA_SMS_MESSAGE_MARKUP_BPS` message markup. The exact nonnegative EUR increment
  permits at most six integer and six fractional digits; markup permits six
  integer digits. Both settings are required in this mode.

For example, 1,500 basis points means a 15 percent markup. Provider-markup mode
multiplies the rental price and each complete message charge by the same factor,
converts through accepted FX when needed, then rounds upwards once at the
established quantum. It does not mark up a previously marked-up amount. Quotes
freeze separate rental/message markup fields and the policy version. The migration
sets existing quotes' rental markup to zero, preserving their original fixed-fee
terms. No existing paid subscription or reservation is repriced by a mode change.
Only USD and EUR provider pricing is supported; other currencies fail closed.

### Provider-charge coverage and unsupported charges

| Component | Evidence and collection |
| --- | --- |
| Standard mobile-number rental, including the first month charged on acquisition | Twilio account-specific monthly `current_price`; marked up in the exact-number monthly Stripe subscription |
| Inbound/outbound message transport and included carrier fees | Complete verified Message charge; same markup and canonical prepaid settlement |
| Failure/processing fees included in a Message receipt | Same markup on the verified total; unknown, zero-segment or above-bound evidence remains held/reconciliation rather than being treated as free |
| Additional per-segment/per-message bounds | Accepted route evidence protects the prepaid reservation; final settlement still uses actual provider cost, not the maximum |
| Basic Lookup | The current adapter requests only free basic validation; no paid enrichment |
| Setup, registration, regulatory, premium-number, or other separate fees | Not silently folded into a recurring monthly price. The current public contract has no one-time-charge Checkout; a flow requiring such a fee must not be provisioned until it has an explicit evidence-backed quote/collection path |

The Phone Numbers Pricing API documents monthly pricing only. Its standard number
cost guide describes a full monthly rental charged on acquisition; that is not a
second setup fee. The adapter rejects extra pricing fields, including newly exposed
setup or ancillary charges, instead of stripping them and underquoting. Absence of
such a field is not proof that a separate contract/account charge does not exist:
operators must review applicable Twilio terms before enabling a provider flow with
additional fees. This implementation neither provisions paid A2P campaigns nor
adds other Twilio services. It does not claim to allocate account-wide taxes or
separately invoiced charges to customers. Such charges require a supported cost
attribution and collection path before they can be incurred on a customer's behalf.

There is no country allowlist in UOA commercial pricing. Provider inventory,
regulatory eligibility, documented fee completeness, supported currency and
customer permissions remain real eligibility checks, not a commercial geography
restriction.

References: https://www.twilio.com/docs/phone-numbers/pricing and
https://help.twilio.com/articles/223182908 (checked 11 October 2026).

Then use **Admin → Billing → SMS policies**:

1. Refresh/import the current official ECB daily XML, review USD-per-EUR and
   explicitly accept this informational reference as commercial policy with a
   reason. Evidence expires seven days after its source date; refreshing the same
   source cannot extend that validity. Renew accepted evidence before expiry.
2. Import route evidence for each exact account, country, inbound/outbound
   direction and provider currency that will be used. Include documentary source,
   source-supported expiry, additional per-segment carrier charge bound, and
   additional per-message processing/failure charge bound. Review and explicitly
   accept both completeness statements. Missing fees in the Pricing API do not
   establish zero; zero requires documentary support. Keep source documents in
   the operator archive. Preview tokens last five minutes.

No accepted FX means `BILLING_SMS_FX_POLICY_REQUIRED`; a missing message-route
bound means `BILLING_SMS_ROUTE_BOUND_REQUIRED`. Both refuse a new quote. FX evidence remains required for every quote, including USD quotes, so the existing
accepted-evidence boundary remains consistent in both modes.

Number acquisition also requires the existing enabled, account/mode-verified
Stripe billing configuration, a paid exact-number subscription and verified cash
payment. An open Checkout does not authorise acquisition. Sending needs sufficient
canonical prepaid credit and budget, current authority, assigned allocation and,
for an agent, the current explicit responsible-agent grant. Nessie's destination
permission gate remains independent of country pricing and billing acceptance.

## 4. Durable Cloud Run deployment

`.github/workflows/deploy-main.yml` uses `--set-env-vars` and `--set-secrets`, so
out-of-band Cloud Run variables would be removed by the next deployment.
Use these repository variables with the existing deployment workflow:

- `UOA_SMS_CONFIGURED=true`: attach the Secret Manager entries below. False is the
  default and attaches none of them.
- `UOA_SMS_PRICING_MODE=provider_markup`: attach the uniform-markup secret below.
  Default `legacy` attaches the two legacy commercial settings instead.
- `BILLING_SMS_TWILIO_REGION=ie1`: select the agreed IE1 messaging/Lookup region.
  Default is `us1`.
- `BILLING_SMS_ENABLED=true`: enable the runtime only after provider, policy,
  accepted evidence and product permission checks are ready. Default is false.
  Deployment refuses this flag without `UOA_SMS_CONFIGURED=true` and
  `STRIPE_BILLING_ENABLED=true` (whose existing Stripe prerequisites still apply).

Create the following Secret Manager entries in the existing UOA project and grant
its deploy/runtime identities access. Values are private; the names below are not:

| Secret Manager name | Runtime variable |
| --- | --- |
| `uoa-auth-sms-twilio-account-sid` | `BILLING_SMS_TWILIO_ACCOUNT_SID` |
| `uoa-auth-sms-twilio-us1-api-key-sid` | `BILLING_SMS_TWILIO_API_KEY_SID` |
| `uoa-auth-sms-twilio-us1-api-key-secret` | `BILLING_SMS_TWILIO_API_KEY_SECRET` |
| `uoa-auth-sms-twilio-ie1-api-key-sid` | `BILLING_SMS_TWILIO_IE1_API_KEY_SID` |
| `uoa-auth-sms-twilio-ie1-api-key-secret` | `BILLING_SMS_TWILIO_IE1_API_KEY_SECRET` |
| `uoa-auth-sms-commercial-policy-version` | `UOA_SMS_COMMERCIAL_POLICY_VERSION` |
| `uoa-auth-sms-provider-markup-bps` | `UOA_SMS_PROVIDER_MARKUP_BPS` (provider-markup mode only) |
| `uoa-auth-sms-monthly-fee-eur` | `UOA_SMS_MONTHLY_FEE_EUR` |
| `uoa-auth-sms-message-markup-bps` | `UOA_SMS_MESSAGE_MARKUP_BPS` |

The IE1 secrets are attached only in IE1 mode. Account/US1 credentials and the
policy version are always attached when configured; only the selected commercial
mode's secrets are attached. No plaintext secret is placed in GitHub variables or command
arguments. Deploy through the normal main workflow, verify the serving revision
and presence of bindings without printing their values, and redeploy the consuming
product with its matching configuration. All migrations and existing production
role/Stripe requirements still apply. This setup does not claim all Twilio
account-level data stays in the EU; Twilio's region documentation states the
scope and exceptions.

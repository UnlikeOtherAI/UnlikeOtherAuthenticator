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

Supply all three private settings; no defaults are provided:

- `UOA_SMS_COMMERCIAL_POLICY_VERSION`: a stable version identifier, 1–80 ASCII
  letters, digits, underscores or hyphens.
- `UOA_SMS_MONTHLY_FEE_EUR`: the agreed nonnegative monthly surcharge in EUR, as
  an exact decimal, at most six integer and six fractional digits.
- `UOA_SMS_MESSAGE_MARKUP_BPS`: the agreed nonnegative integer message markup in
  basis points (100 basis points = 1 percent), at most six digits.

The monthly final USD quote adds the EUR surcharge converted using accepted FX
to the provider number price. Message quotes apply the markup to the complete
provider charge bound. Final amounts round upwards at the established quantum;
accepted quotes freeze their private terms. Only USD and EUR provider pricing
is supported. Changing settings does not reprice an existing reservation.

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
bound means `BILLING_SMS_ROUTE_BOUND_REQUIRED`. Both refuse a new quote. Even a
monthly USD quote needs accepted FX because its fixed surcharge is in EUR.

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
| `uoa-auth-sms-monthly-fee-eur` | `UOA_SMS_MONTHLY_FEE_EUR` |
| `uoa-auth-sms-message-markup-bps` | `UOA_SMS_MESSAGE_MARKUP_BPS` |

The IE1 secrets are attached only in IE1 mode; the remaining six are required
when configured. No plaintext secret is placed in GitHub variables or command
arguments. Deploy through the normal main workflow, verify the serving revision
and presence of bindings without printing their values, and redeploy the consuming
product with its matching configuration. All migrations and existing production
role/Stripe requirements still apply. This setup does not claim all Twilio
account-level data stays in the EU; Twilio's region documentation states the
scope and exceptions.

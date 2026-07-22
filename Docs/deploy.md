# Deployment

## Target

- **Platform:** Google Cloud Run
- **Region:** `europe-west1`
- **Service name:** `uoa-auth`
- **Domain:** `https://authentication.unlikeotherai.com`
- **GCP Project:** `gen-lang-client-0561071620`
- **Artifact Registry:** `europe-west1-docker.pkg.dev/gen-lang-client-0561071620/uoa-docker/uoa-auth`
- **Cloud SQL:** `gen-lang-client-0561071620:europe-west1:uoa-auth-db`

## How to deploy

### Automatic deploys

- Push to `main` triggers GitHub Actions workflow [deploy-main.yml](/System/Volumes/Data/.internal/projects/Projects/UnlikeOtherAuthenticator/.github/workflows/deploy-main.yml).
- The workflow:
  - authenticates to Google Cloud via GitHub OIDC workload identity
  - builds the API, Auth UI, and Admin UI into one container image and pushes it to Artifact Registry
  - deploys the new image to Cloud Run service `uoa-auth`; revision startup
    applies Prisma migrations through the separate `DATABASE_ADMIN_URL`, then
    runs the API with the original `DATABASE_URL`
  - checks `https://authentication.unlikeotherai.com/health`

The production root `https://authentication.unlikeotherai.com/` is a Tailwind holding page with links to Admin, `/llm`, and `/api`. The Admin UI is served by the same Cloud Run API service at `https://authentication.unlikeotherai.com/admin`.

### GitHub Actions configuration

Configured as GitHub repository variables:

| Variable                           | Value                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`                   | `gen-lang-client-0561071620`                                                                   |
| `GCP_REGION`                       | `europe-west1`                                                                                 |
| `GCP_CLOUD_RUN_SERVICE`            | `uoa-auth`                                                                                     |
| `GCP_ARTIFACT_REGISTRY_REPOSITORY` | `uoa-docker`                                                                                   |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`   | `projects/193510011126/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_SERVICE_ACCOUNT`              | `gha-uoa-auth-deploy@gen-lang-client-0561071620.iam.gserviceaccount.com`                       |

The workload identity provider is restricted to GitHub repository `UnlikeOtherAI/UnlikeOtherAuthenticator`.

Every main-branch deployment records the exact `latestCreatedRevisionName`,
explicitly routes 100% of service traffic to that revision, and verifies it is
the `latestReadyRevisionName` before probing the public health endpoints. This
explicit promotion is required after a canary or rollback pins traffic to a
named revision: a successful image upload plus a health response from the old
revision is not a successful deployment.

### Manual fallback

```bash
# 1. Get the current commit hash for the image tag
TAG=$(git rev-parse --short HEAD)

# 2. Build the Docker image via Cloud Build
gcloud builds submit \
  --tag europe-west1-docker.pkg.dev/gen-lang-client-0561071620/uoa-docker/uoa-auth:$TAG \
  --region=europe-west1

# 3. Deploy to Cloud Run
gcloud run deploy uoa-auth \
  --region europe-west1 \
  --image europe-west1-docker.pkg.dev/gen-lang-client-0561071620/uoa-docker/uoa-auth:$TAG

# 4. Verify
curl https://authentication.unlikeotherai.com/health
```

## Environment variables

Set via Cloud Run service config:

| Variable                                    | Source                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SERVICE_IDENTIFIER`                   | Optional plain override; internal issuer/audience for service-issued tokens. Defaults to the `PUBLIC_BASE_URL` host and is not required in client config JWTs                                                                                                                                         |
| `ADMIN_AUTH_DOMAIN`                         | Optional plain override; domain allowed into the Admin panel. Defaults to the resolved auth service identifier                                                                                                                                                                                        |
| `ADMIN_ACCESS_TOKEN_SECRET`                 | Secret Manager: `uoa-admin-access-token-secret`; used to sign tokens issued for `ADMIN_AUTH_DOMAIN`; route-level requirement for admin access                                                                                                                                                         |
| `ADMIN_CONFIG_JWT`                          | Secret Manager: `uoa-admin-config-jwt`; signed RS256 config JWT served from `/internal/admin/config`; must disable registration and allow only Google                                                                                                                                                 |
| `ADMIN_BOOTSTRAP_EMAILS`                    | Optional comma-separated allowlist of emails allowed to bootstrap the initial `SUPERUSER` on `ADMIN_AUTH_DOMAIN`. Unset → first admin-domain login wins                                                                                                                                               |
| `CONFIG_JWKS_URL`                           | Plain value: `https://authentication.unlikeotherai.com/.well-known/jwks.json`; trusted JWKS URL for RS256 config JWT verification; route-level requirement for config-backed auth                                                                                                                     |
| `CONFIG_JWKS_JSON`                          | Secret Manager: `uoa-auth-config-jwks-json`; public JWKS JSON served from `/.well-known/jwks.json`; must contain public keys only                                                                                                                                                                     |
| `PUBLIC_BASE_URL`                           | Plain value: `https://authentication.unlikeotherai.com`                                                                                                                                                                                                                                               |
| `DATABASE_URL`                              | Secret Manager: `uoa-auth-database-url`; runtime connection used for post-context tenant DB paths; production must connect as `uoa_app` and must not have `BYPASSRLS`                                                                                                                                 |
| `DATABASE_ADMIN_URL`                        | Secret Manager: `uoa-auth-database-admin-url`; bootstrap/admin connection used for the production migration subprocess, domain-hash auth, admin routes, auto-onboarding, claim flow, retention pruning, audit log, and `/.well-known/jwks.json`; must connect as a `BYPASSRLS` role (`uoa_admin`). Application-client fallback to `DATABASE_URL` is for explicit development/test environments only; production container startup fails when this value is absent |
| `SHARED_SECRET`                             | Secret Manager: `uoa-auth-shared-secret`                                                                                                                                                                                                                                                              |
| `GOOGLE_CLIENT_ID`                          | Secret Manager: `uoa-auth-google-client-id`                                                                                                                                                                                                                                                           |
| `GOOGLE_CLIENT_SECRET`                      | Secret Manager: `uoa-auth-google-client-secret`                                                                                                                                                                                                                                                       |
| `MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK`        | Secret Manager: `uoa-auth-mcp-oauth-access-token-private-jwk`; RS256 private JWK (JSON) for confidential resource tokens and optional public-profile tokens. Its public half is served at `/oauth/jwks.json`; key presence alone does not open public OAuth routes                                    |
| `MCP_OAUTH_PUBLIC_PROFILE_ENABLED`          | Plain production value: `false` for the confidential-only Ledger rollout. Set `true` only in a separate reviewed change that also configures the dedicated public profile                                                                                                                             |
| `MCP_OAUTH_DOMAIN`                          | Required only when `MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true`; must be a dedicated first-party tenant distinct from `ADMIN_AUTH_DOMAIN` and customer domains                                                                                                                                             |
| `MCP_OAUTH_RESOURCES_SUPPORTED`             | Used only by the explicitly enabled public profile; case-sensitive RFC 8707 resource allowlist                                                                                                                                                                                                        |
| `TARIFF_SNAPSHOT_PRIVATE_JWK`               | Secret Manager: `uoa-auth-tariff-snapshot-private-jwk`; dedicated current RS256 private RSA JWK for signed tariff snapshots. Configure it only with the matching public JWKS; do not reuse another UOA signing key                                                                                    |
| `TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON`          | Secret Manager: `uoa-auth-tariff-snapshot-public-jwks-json`; public-only JWKS containing the current tariff key and overlapping retired verification keys. The current entry must exactly match the private key's `kid`, modulus, and exponent                                                        |
| `STRIPE_BILLING_ENABLED`                    | Plain safety gate. Production default is `false`; Stripe and Ledger collection calls are forbidden until every launch prerequisite below is verified                                                                                                                                                  |
| `STRIPE_SECRET_KEY`                         | Secret Manager: dedicated Stripe restricted/live key for UOA billing. Presence alone does not enable billing                                                                                                                                                                                          |
| `STRIPE_WEBHOOK_SECRET`                     | Secret Manager: Stripe endpoint signing secret for `/billing/v1/stripe/webhook`; never reuse a product app key or Ledger key                                                                                                                                                                          |
| `STRIPE_USAGE_EXPORT_INTERVAL_MINUTES`      | Plain recurring collector interval, 5–1,440 minutes; workflow default 60                                                                                                                                                                                                                              |
| `STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES`       | Plain exact-team automatic-credit-top-up poll interval, 1–60 minutes; default 1. It is inert while `STRIPE_BILLING_ENABLED=false`                                                                                                                                                                     |
| `STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES`   | Plain horizon in which the additional pre-boundary safety timer is scheduled; workflow default 360 and must cover interval plus offset                                                                                                                                                                |
| `STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES` | Plain offset before UTC billing-period end for the safety pass; workflow default 1. This is not the final reconciliation                                                                                                                                                                              |
| `LEDGER_BILLING_BASE_URL`                   | Plain credential-free HTTPS Ledger origin, canonical production value `https://ledger.unlikeotherai.com`                                                                                                                                                                                              |
| `LEDGER_BILLING_APP_KEY`                    | Secret Manager: UOA's own dedicated, product-bound Ledger raw-metering reader app key. Never reuse a Nessie, DeepWater, DeepSignal, DeepTest, user, or webhook credential                                                                                                                             |
| `LEDGER_BILLING_APP_KEY_ID`                 | Plain immutable Ledger record ID for that exact UOA app key; copied into the signed assertion's `azp` and verified by Ledger                                                                                                                                                                          |
| `LEDGER_BILLING_ASSERTION_AUDIENCE`         | Exact Ledger service-assertion audience, canonical production value `https://ledger.unlikeotherai.com`                                                                                                                                                                                                |
| `UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK` | Secret Manager: dedicated current RS256 private JWK used only for short-lived UOA→Ledger `metering.read` assertions                                                                                                                                                                                   |
| `UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON`    | Secret Manager: public-only current and overlapping retired assertion keys served at `/billing/v1/service-jwks.json`; current public pair must match the private key                                                                                                                                  |

`/llm` is a Markdown integration guide for LLMs and human readers. `/api` is the machine-readable JSON schema and config contract.

### Database role verification and rollback-safe rotation

`docker/start-production.sh` enforces the process boundary. In production it
requires both database URLs, gives only the `prisma migrate deploy` subprocess a
command-scoped `DATABASE_URL=$DATABASE_ADMIN_URL`, and then `exec`s Node with
the original `DATABASE_URL` untouched. It never prints either URL. Explicit
development and test databases may deliberately omit
`DATABASE_ADMIN_URL`, in which case migrations use `DATABASE_URL`. Do not move
the admin assignment into the parent shell or export it: that would silently
run the API as the RLS-bypassing principal.

Production requires two genuinely distinct principals. `DATABASE_URL` must
report `current_user = 'uoa_app'`; `DATABASE_ADMIN_URL` must report
`current_user = 'uoa_admin'`, and only the latter may have `BYPASSRLS`. Merely
using two Secret Manager names is not evidence that the credentials differ.
The opt-in, read-only canary verifies the role split, confirms that `uoa_app`
cannot read the product billing control plane, and proves that an ordinary
pre-auth tenant transaction can receive cross-product choices only through the
explicit admin client:

```sh
RUN_PRODUCT_WORKSPACE_RLS_TESTS=true \
  DATABASE_URL='<uoa_app DSN>' \
  DATABASE_ADMIN_URL='<uoa_admin DSN>' \
  pnpm --filter @uoa/api exec vitest run \
    tests/integration/product-workspace-policy-rls.test.ts
```

Product-workspace policy is a live token-issuance kill switch. Change
`client_domains.status`, `billing_services.active`, lifecycle
`billing_app_keys`, or integration acceptance only through the supported Admin
services: domain create/update, BillingService create, lifecycle app-key
create/revoke, and integration-request acceptance. Those paths take the global
exclusive product-policy advisory lock. Direct SQL changes are prohibited
because they can bypass issuance linearization; any future service-disable or
mapping mutator must take the same exclusive lock before its first policy read
or write. App-key secret rotation does not change this mapping rule.

Never print either DSN or place it in shell history. Keep
`STRIPE_BILLING_ENABLED=false` throughout this repair. To repair a drifted
runtime credential without an all-at-once cutover:

1. Keep the current deployed Secret Manager version enabled for rollback and
   confirm the pre-release on-demand backup is successful.
2. Deploy and verify the command-scoped migration startup boundary above while
   the current revision still uses its existing credentials. This is the
   bootstrap prerequisite for a later `uoa_app` runtime revision; without it,
   Prisma tries to migrate as `uoa_app` and the container correctly cannot
   start because that role has neither migration-table nor schema-create
   privileges.
3. Generate a new random `uoa_app` password and set it through an audited Cloud
   SQL administrator or credential-management path (for example, the Cloud SQL
   users set-password operation). Do not assume the runtime `uoa_admin` role has
   `CREATEROLE`. Construct the candidate DSN entirely in a protected local
   environment.
4. Run `SELECT current_user`, the canary above, API typecheck, and focused auth
   tests against the candidate before storing it.
5. Put the validated DSN in a separate temporary Secret Manager secret with an
   explicit numeric version, not in `uoa-auth-database-url`. Deploy a no-traffic
   revision pinned to that temporary secret version, verify startup/health and
   one same-domain plus one product-domain login, then move traffic gradually.
   The currently serving revision's `latest` reference cannot discover this
   separate secret. Keep one startup-boundary revision pinned to the old
   numeric `uoa-auth-database-url` version as the admin-runtime rollback target.
6. After the candidate revision holds 100% traffic and its post-cutover canaries
   pass, add the exact already-tested DSN as the next version of
   `uoa-auth-database-url`. Do not change `uoa-auth-database-admin-url`. Trigger
   the normal deployment workflow and verify that its new `latest` binding
   resolves to `uoa_app`; every subsequent workflow deployment then inherits
   the corrected runtime principal. Keep the temporary-secret revision as the
   immediate rollback while this canonical deployment is observed.
7. If a check fails before canonical promotion, move traffic back to the old
   startup-boundary revision; the canonical secret is still unchanged. If it
   fails after promotion, move traffic to the known-good temporary-secret
   revision. To restore the old admin runtime, disable the new canonical secret
   version, deploy the explicitly pinned old version, and verify health. Do not
   weaken RLS grants as a workaround.
8. After the observation window, disable superseded canonical runtime-secret
   versions, retire the temporary candidate secret only after no revision uses
   it, and record the rotation evidence. Keep the admin credential separately
   scoped and independently rotatable.

On 2026-07-21 the production-role canary found both configured DSNs connecting
as `uoa_admin`; no valid historical `uoa_app` secret version was available.
That credential repair is intentionally a separate, approved production
operation. Code deployment must not be represented as restoring RLS until the
canary passes with distinct roles.

The 2026-07-22 read-only release audit confirmed that `uoa_app` is a LOGIN role
without `BYPASSRLS`, `uoa_admin` is a LOGIN role with `BYPASSRLS`, 93 of 96
tables have RLS enabled, 92 force it, and 148 policies are installed. Runtime
secret versions 1 and 2 were obsolete PostgreSQL-superuser credentials and are
now disabled after rotating that superuser password. Version 3 is the only
enabled runtime-secret version and still authenticates as `uoa_admin`; no
stored credential authenticates as `uoa_app`. The candidate therefore requires
an audited `uoa_app` password reset and the staged cutover above.

The deploy workflow also reads two GitHub repository variables that are not
runtime application config:

- `UOA_STRIPE_BILLING_CONFIGURED` defaults to `false`. Only exact `true`
  attaches the two Stripe Secret Manager entries.
- `STRIPE_BILLING_ENABLED` defaults to `false`. Exact `true` additionally
  requires the configured flag and all Ledger collector identifiers, keeps one
  Cloud Run instance warm, and disables CPU throttling so the recurring
  scheduler and pre-boundary safety timer run. False deploys with zero minimum
  instances and throttled idle CPU.

Tariff-signing, billing-assertion, and UOA's Ledger collector credentials are
wired on every deployment because they are required for signed entitlement and
reconciliation readiness; that does not enable Stripe or create billable
resources.

Contract invoice calculation is database-backed and remains available without
PDF storage. Issuance is deliberately fail-closed until an operator creates an
explicit issuer legal profile and configures a dedicated private object store.
Set `BILLING_INVOICE_STORAGE_PROVIDER=gcs`,
`BILLING_INVOICE_GCS_BUCKET` to a bucket with public access prevention, and
optionally `BILLING_INVOICE_GCS_PROJECT_ID`. Grant the Cloud Run runtime identity
create/read access only; invoice objects are create-only and are never deleted
or overwritten by the application. The deploy workflow accepts only `disabled`
or `gcs` in production and refuses `gcs` without the bucket variable.
Configure those values as GitHub repository variables; the main-branch workflow
passes them to Cloud Run on every deployment. It also forwards
`STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES` (default `1`) so the documented bounded
auto-top-up cadence is not silently replaced by an old revision's environment.

The private key used to sign `ADMIN_CONFIG_JWT` is not attached to Cloud Run. Store it separately in Secret Manager as `uoa-auth-config-jwt-private-jwk` for rotation/signing operations only.

Before enabling the confidential exchange in production:

1. Create `uoa-auth-mcp-oauth-access-token-private-jwk` as an RSA private JWK
   with `alg=RS256`, a unique `kid`, and public `n`/`e` members; grant both the
   Cloud Run runtime identity and GitHub deployment identity Secret Manager
   accessor permission.
2. Keep `MCP_OAUTH_PUBLIC_PROFILE_ENABLED=false`; confidential signing and JWKS
   publication do not require a public OAuth tenant.
3. Apply
   `20260719020000_add_confidential_delegation_mappings` before the application
   revision receives confidential exchanges.
4. Confirm every calling product (initially Nessie, DeepWater, DeepSignal, and
   DeepTest) has its own active registered `ClientDomain` and its own existing
   domain-hash app credential. Never distribute one product's credential to
   another product.
5. Confirm each source domain publishes its assertion signing public key at the
   same-host `jwks_url` in its config JWT.
6. In the authenticated Admin panel, open **Settings → Delegation mappings** and
   create one mapping per source domain/product with the exact target HTTPS
   resource and the smallest required subset of `ai.invoke`, `billing.read`,
   and the separately granted `token.provision`. The panel calls
   `/internal/admin/confidential-delegations` with the existing same-origin
   admin session; do not extract the browser token or expose a product
   credential. `token.provision` is only for a dedicated Coder provisioner and
   must never be inferred from `ai.invoke`. Mapping state is database-backed;
   do not add source/resource env fallbacks.
7. Verify `GET https://authentication.unlikeotherai.com/oauth/jwks.json` returns
   the configured public key, while discovery, registration, authorize, login,
   and `/oauth/token` return 404. Exercise correct and wrong product credentials,
   resource variants, scope widening, disabled mapping, replay, and selected
   user/organisation/team membership before enabling confidential callers.
8. For each approved chain, provision both independent mappings. The
   Nessie→DeepSignal→Ledger path requires Nessie's mapping to the exact
   DeepSignal API origin and DeepSignal's separate mapping to the exact Ledger
   resource, each with only `ai.invoke` unless another scope is explicitly
   approved. Nessie and DeepSignal must present their own registered credentials;
   never configure either product with the other product's key or a webhook
   signing secret.
9. Exercise the chained `subject_token_type=...:access_token` path with a
   UOA-issued token whose audience is exactly the authenticated DeepSignal
   origin. Verify wrong audience/issuer/signature, inactive original mapping,
   removed user/org/team, and either-hop scope widening fail; verify the output
   expiry does not exceed the inbound expiry and `act` records the upstream
   source/product. The access-token subject may be reused until expiry for
   concurrent instances; the original source-JWT assertion must remain one-time.

The secret value is one private RSA JWK JSON object with at least
`kty="RSA"`, `alg="RS256"`, `use="sig"`, non-empty `kid`, public `n`/`e`, and
private `d` (generated keys also include the CRT members). Generate it and send
it directly to Secret Manager without printing it to the terminal:

```bash
gcloud secrets describe uoa-auth-mcp-oauth-access-token-private-jwk \
  --project gen-lang-client-0561071620 >/dev/null 2>&1 ||
gcloud secrets create uoa-auth-mcp-oauth-access-token-private-jwk \
  --project gen-lang-client-0561071620 \
  --replication-policy=automatic

pnpm --filter @uoa/api exec node --input-type=module -e \
  'import { randomUUID } from "node:crypto"; import { exportJWK, generateKeyPair } from "jose"; const { privateKey } = await generateKeyPair("RS256", { extractable: true }); const jwk = await exportJWK(privateKey); Object.assign(jwk, { kid: `uoa-access-${randomUUID()}`, alg: "RS256", use: "sig" }); process.stdout.write(JSON.stringify(jwk));' |
gcloud secrets versions add uoa-auth-mcp-oauth-access-token-private-jwk \
  --project gen-lang-client-0561071620 \
  --data-file=-
```

### Billing tariff production prerequisites (not enabled)

Merging the code and database migration does not mint product credentials or
enable tariff lookups in production. Before connecting Ledger or another
product:

1. Provision `uoa-auth-tariff-snapshot-private-jwk` as a dedicated current
   private RSA JWK with `alg=RS256`, `use=sig`, and a unique `kid`. Provision
   `uoa-auth-tariff-snapshot-public-jwks-json` with the exact matching public key
   plus any retired keys still inside the rotation overlap. Grant the Cloud Run
   runtime identity access and configure both
   `TARIFF_SNAPSHOT_PRIVATE_JWK` and
   `TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON`; UOA imports every configured key before
   serving and fails startup when any key is unusable.
2. Apply the migration and create each billing service with an explicit default
   tariff through the platform-superuser API. The account-scoping migration
   deliberately aborts if any pre-launch Stripe projection already exists,
   because no trustworthy Stripe account/mode can be inferred; explicitly
   reconcile or remove such rows before retrying rather than backfilling them.
3. Mint different named `uoa_app_…` keys for every application connection and
   endpoint purpose. Use `entitlement` for effective-tariff reads and
   `customer_lifecycle` for Checkout/summary/portal/cancellation; never reuse
   one key across those classes.
   Transfer its plaintext once through the approved secret channel; UOA cannot
   recover it later.
4. Bind each key to that caller's HTTPS actor issuer, the exact
   `https://authentication.unlikeotherai.com/billing/v1/effective-tariff`
   audience, and its RS256 public JWK.
5. Verify `/billing/v1/jwks.json`, a signed actor lookup, exact signed
   product/app-key/user/organisation/team binding, team/organisation/default
   precedence, key revocation, and the consumer's separately labeled raw usage,
   product-appropriate billable units (token-, search-, or research-equivalent),
   and price presentation before enabling charges.

For a product that also consumes a runtime UOA feature capability, provision
one active `App` row with that product's exact config domain, enable feature
flags, and create the exact flag definition with a fail-closed `false` default.
The backend stores the opaque `App.id` and calls
`GET /apps/:appId/flags?domain=<config-domain>&userId=<UOA-sub>&teamId=<UOA-team>`
using its own domain-hash credential. Production canaries must exercise that
real credential without printing it. Do not copy legacy local subscription or
feature fields automatically: they are not current authority. Until an
operator performs an explicit, audited UOA override import, legacy grants fail
closed.

Rotate tariff snapshot keys with an overlap:

1. Publish the new public key alongside the current and still-valid retired
   keys while continuing to sign with the old private key. Wait at least the
   JWKS cache lifetime (currently five minutes).
2. Switch `TARIFF_SNAPSHOT_PRIVATE_JWK` to the new key while every rolling
   revision serves the same overlapping public set.
3. After all old snapshots have expired, all traffic uses the new revision, and
   at least the snapshot lifetime (currently five minutes) has elapsed, remove
   the retired public key. Never remove it in the same rollout that changes the
   signer.

Tariff versions store `collection_mode = stripe | manual | none`, and signed
snapshots expose collection intent separately from usage rating.
`collection_mode=stripe` still does not mean collection is active: the Stripe
foundation is fail-closed behind `STRIPE_BILLING_ENABLED`.

Before enabling it in production:

1. Create and transfer a distinct UOA-owned Ledger raw-metering reader app key.
   Configure it for `metering.read` only; record the exact key ID separately.
2. Generate a dedicated billing-assertion RSA key pair, publish the public
   current/retired overlap through
   `UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON`, and configure Ledger to trust
   `https://authentication.unlikeotherai.com/billing/v1/service-jwks.json`.
   Rotate it with the same publish → wait → switch signer → wait → retire
   sequence used for tariff keys.
3. Provision Stripe test-mode API and webhook secrets. Create a dedicated UOA
   endpoint at `https://authentication.unlikeotherai.com/billing/v1/stripe/webhook`
   pinned to API version `2026-06-24.dahlia`; a different event API version is
   rejected. Subscribe it to exactly:
   - `checkout.session.completed`, `checkout.session.expired`;
   - `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.pending_update_applied`, and
     `customer.subscription.resumed`;
   - `invoice.created`, `invoice.finalization_failed`, `invoice.paid`,
     `invoice.payment_failed`, `invoice.marked_uncollectible`, and
     `invoice.voided`;
   - `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.processing`, `payment_intent.requires_action`, and
     `payment_intent.canceled`;
   - `setup_intent.succeeded`;
   - `refund.created`, `refund.updated`, `refund.failed`;
   - `charge.dispute.funds_withdrawn`,
     `charge.dispute.funds_reinstated`.

   Do not reuse or modify another product's endpoint. Confirm raw-body signature
   validation, signed/current reserved-metadata agreement, and idempotent replay.
   Prove a recurring add-on Checkout completion creates no entitlement until its
   exact undiscounted `subscription_create` `invoice.paid` event arrives. Then
   prove an amount, Price, discount, tax, credit, quantity, item, customer, or
   subscription mismatch remains retryable and cannot activate the add-on.
   While `STRIPE_BILLING_ENABLED=false`, invoice reconciliation events return a
   retryable error and are not recorded as consumed; reconcile them before or
   immediately after enabling collection. Other UOA lifecycle and corrective
   webhooks remain live when the collection gate is off. The API key must use an
   explicit `sk_test_`/`rk_test_` or `sk_live_`/`rk_live_` prefix; unknown mode
   fails startup. Confirm `/v1/account` resolves the intended Stripe account.

4. Mint a separate `customer_lifecycle` `uoa_app_…` key for each
   product/deployment. Use it for that product's mandatory post-SSO
   `/billing/v1/service-access/confirm` call, canonical statement, shared-credit
   and recurring-add-on reads, and customer billing lifecycle;
   bind only its own actor issuer/key and exact HTTPS return origins. Keep its
   `entitlement` key separate and origin-free.
5. Exercise credentialed current-month `group_by=service` and `group_by=user`
   `metering-usage-v1` reads plus the single exact-team
   `metering-portfolio-v1?group_by=user` read with `view=team_portfolio`. Prove
   v2 derives rating plus every service, origin, and user total from that one
   pinned snapshot; indirect or unattributed origin use must not become
   direct-access or cancellation evidence. Then verify UOA central
   rating, monthly fixed charges, add-ons/credits, rated-usage deltas, zero and
   negative corrections, lost-response replay, UTC month boundaries, the
   pre-boundary safety pass, and authoritative post-period `invoice.created`
   reconciliation against immutable Ledger cursors. Prove usage in the final
   minute reaches the draft invoice during Stripe's configured finalization
   grace period. For shared credits, race four independent product clients with
   distinct current cumulative cursors for the same exact team and prove every
   read settles, the usage is debited only once, and all snapshots remain
   complete. Replay one cursor and prove it adds no adjustment or debit. Then
   apply a lower corrected cursor and verify that credits are released and user
   attribution is reallocated without rewriting history.
6. Review the deployed recurring collector interval, safety lead/offset, Cloud
   Run warm-instance/non-throttled CPU settings, the Stripe webhook
   subscriptions for `invoice.created` and `invoice.finalization_failed`, the
   account finalization-grace setting (cycle invoices must expose at least one
   hour; shorter/custom-early windows fail closed), and failure alerts. Stripe
   meter events aggregate asynchronously, so verify the finalized test invoice;
   a successful event response or manual export is not adequate evidence.
7. Reconcile test invoices to UOA's exact tariff version and Ledger's customer
   charge. Before switching to live, verify the live key resolves the intended
   account, creates a separate live projection from test resources, and that no
   Checkout/subscription remains pinned to a tariff or assignment operators
   intend to replace. Then set `STRIPE_BILLING_ENABLED=true` with live
   credentials.

The workflow wires the automated schedule but leaves it inert by default. It
does not create or infer live Stripe credentials, enable the gate, or provision
Stripe customers/subscriptions. Those remain explicit operator actions after
test-mode evidence and review.

#### Provision the immutable Stripe commercial catalog

Provisioning UOA's local credit and recurring-add-on catalog is an explicit
operator step. It validates pre-existing Stripe objects and maps their IDs into
UOA; it never creates or mutates a Stripe Product or Price, never enables
`STRIPE_BILLING_ENABLED`, and does not configure customers, subscriptions, or
webhooks.

Prerequisites:

- `STRIPE_SECRET_KEY` must be the key for the intended account and selected
  mode. The command rejects a test/live mismatch before its first network call.
- `DATABASE_ADMIN_URL`, falling back to `DATABASE_URL`, must target the intended
  UOA database.
- The provisioner constructs its own short-lived admin Prisma client from that
  URL. It intentionally does not load or require unrelated API-server settings
  such as `SHARED_SECRET`, which keeps the documented two-secret operator job
  isolated from the runtime service configuration.
- The database must contain exactly the active billing services `nessie`,
  `deepwater`, `deepsignal`, and `deeptest`, and exactly one active,
  feature-flags-enabled app identified as `deepwater-api`. Unexpected active
  services or ambiguous app state fail closed.
- Stripe must already contain one shared-credit Product, its four active
  one-time USD Prices, and a distinct DeepWater privacy Product with its active
  monthly licensed USD Price. Prices are located by lookup key, so Stripe IDs
  are neither copied into source nor supplied on the command line.

The exact Stripe contract is:

| Object                    | Lookup/terms                                                      | Exact metadata                                                                                      |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared-credit Product     | active                                                            | `contract_version=1`, `credits_per_usd=1000`, `uoa_kind=team_credits`                               |
| US$10 credit Price        | `uoa_credits_usd_10_v1`, one-time, 10,000 credits                 | `credits=10000`, `uoa_kind=team_credit_top_up`                                                      |
| US$25 credit Price        | `uoa_credits_usd_25_v1`, one-time, 25,000 credits                 | `credits=25000`, `uoa_kind=team_credit_top_up`                                                      |
| US$50 credit Price        | `uoa_credits_usd_50_v1`, one-time, 50,000 credits                 | `credits=50000`, `uoa_kind=team_credit_top_up`                                                      |
| US$100 credit Price       | `uoa_credits_usd_100_v1`, one-time, 100,000 credits               | `credits=100000`, `uoa_kind=team_credit_top_up`                                                     |
| DeepWater privacy Product | active, distinct from credit Product                              | `contract_version=1`, `uoa_addon_key=privacy`, `uoa_kind=recurring_addon`, `uoa_service=deep-water` |
| DeepWater privacy Price   | `deepwater_privacy_usd_month_v1`, US$50/month, licensed, no meter | `uoa_addon_key=privacy`, `uoa_kind=recurring_addon`, `uoa_service=deep-water`                       |

Metadata is an exact set: extra, absent, or changed keys are drift. Begin with
the read-only operation:

```bash
STRIPE_SECRET_KEY='sk_test_...' DATABASE_ADMIN_URL='postgresql://...' \
  pnpm billing:provision-stripe-catalog \
  --dry-run --stripe-account acct_REPLACE_ME --stripe-mode test
```

In dry-run output, `created` actions are planned local inserts or bindings; no
database write has occurred. Review the account, mode, and complete action list.
Apply only with the exact account-and-mode confirmation:

```bash
STRIPE_SECRET_KEY='sk_test_...' DATABASE_ADMIN_URL='postgresql://...' \
  pnpm billing:provision-stripe-catalog \
  --apply --stripe-account acct_REPLACE_ME --stripe-mode test \
  --confirm 'PROVISION_UOA_STRIPE_CATALOG:acct_REPLACE_ME:test'
```

For live mode, use an `sk_live_...` key, `--stripe-mode live`, and the `:live`
confirmation suffix. Apply revalidates Stripe before opening one serializable
database transaction. It creates only missing exact UOA rows and binds only
catalog rows whose Product and Price IDs are both null. Any partial binding,
changed immutable term, or remote mismatch aborts the whole operation. A second
exact run reports no-op actions. Output contains IDs and decisions but no
credentials.

The opt-in PostgreSQL credit-settlement integration gate is:

```bash
BILLING_FUNDING_DATABASE_TESTS=true DATABASE_URL='<isolated PostgreSQL URL>' \
  pnpm --filter @uoa/api exec vitest run \
  tests/integration/billing-credit-settlement.persistence.test.ts
```

Run it only against a disposable database: the shared test helper applies the
complete migration chain and creates/drops an isolated test database.

### Signature module production prerequisites (not enabled)

The per-domain agreement-signature service remains process-disabled by default and this implementation work does not change the Cloud Run service configuration or enable any production domain. Before production enablement, operators must provision and review all of the following together:

Apply migration \`20260722153000_add_signature_claim_intents\` before deploying a revision
that accepts signing submissions. The new path requires its durable claim table; the
nullable link on historical signatures preserves existing append-only evidence. Do not
work around a missing migration by returning object/PDF/cryptographic work to the policy
transaction.

| Variable / dependency                                 | Required production configuration                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNATURE_STORAGE_PROVIDER`                          | `gcs`; local filesystem storage is rejected in production                                                                                                                 |
| `SIGNATURE_GCS_BUCKET`                                | Dedicated private bucket with public access prevention, residency/backup/lifecycle policy, and create/read/delete permissions restricted to the Cloud Run service account |
| `SIGNATURE_GCS_PROJECT_ID`                            | Optional project override when the bucket is outside the runtime project                                                                                                  |
| `SIGNATURE_MALWARE_SCANNER`                           | `clamav`; uploads fail closed while disabled or unavailable                                                                                                               |
| `SIGNATURE_CLAMDSCAN_PATH`                            | Path to the reviewed `clamdscan` client in the runtime image; a reachable, updated ClamAV daemon is also required                                                         |
| `SIGNATURE_MALWARE_SCAN_TIMEOUT_MS`                   | Bounded scan timeout, default 30 seconds                                                                                                                                  |
| `SIGNATURE_EVIDENCE_PRIVATE_JWK`                      | Secret Manager: dedicated RS256 private RSA JWK with a unique `kid`; never reuse another UOA signing key                                                                  |
| `SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON`                 | Public-only current and retired evidence keys; must include the private key's current `kid`                                                                               |
| `SIGNATURE_MAX_PDF_BYTES` / `SIGNATURE_MAX_PDF_PAGES` | Reviewed operational upload bounds (implementation defaults: 25 MiB / 200 pages)                                                                                          |

Enabling an individual domain additionally requires an explicit retention period and at least one active published required agreement version. Legal retention, bucket residency, encryption-key ownership, evidence-key custody/rotation, ClamAV packaging, and backup policy require an approved production change; they are not inferred from local defaults.

## Service config

- Max instances: 3
- Startup CPU boost: enabled
- Cloud SQL connection: `gen-lang-client-0561071620:europe-west1:uoa-auth-db`

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
  - deploys the new image to Cloud Run service `uoa-auth`
  - checks `https://authentication.unlikeotherai.com/health`

The production root `https://authentication.unlikeotherai.com/` is a Tailwind holding page with links to Admin, `/llm`, and `/api`. The Admin UI is served by the same Cloud Run API service at `https://authentication.unlikeotherai.com/admin`.

### GitHub Actions configuration

Configured as GitHub repository variables:

| Variable | Value |
|----------|-------|
| `GCP_PROJECT_ID` | `gen-lang-client-0561071620` |
| `GCP_REGION` | `europe-west1` |
| `GCP_CLOUD_RUN_SERVICE` | `uoa-auth` |
| `GCP_ARTIFACT_REGISTRY_REPOSITORY` | `uoa-docker` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/193510011126/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `gha-uoa-auth-deploy@gen-lang-client-0561071620.iam.gserviceaccount.com` |

The workload identity provider is restricted to GitHub repository `UnlikeOtherAI/UnlikeOtherAuthenticator`.

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

| Variable | Source |
|----------|--------|
| `AUTH_SERVICE_IDENTIFIER` | Optional plain override; internal issuer/audience for service-issued tokens. Defaults to the `PUBLIC_BASE_URL` host and is not required in client config JWTs |
| `ADMIN_AUTH_DOMAIN` | Optional plain override; domain allowed into the Admin panel. Defaults to the resolved auth service identifier |
| `ADMIN_ACCESS_TOKEN_SECRET` | Secret Manager: `uoa-admin-access-token-secret`; used to sign tokens issued for `ADMIN_AUTH_DOMAIN`; route-level requirement for admin access |
| `ADMIN_CONFIG_JWT` | Secret Manager: `uoa-admin-config-jwt`; signed RS256 config JWT served from `/internal/admin/config`; must disable registration and allow only Google |
| `ADMIN_BOOTSTRAP_EMAILS` | Optional comma-separated allowlist of emails allowed to bootstrap the initial `SUPERUSER` on `ADMIN_AUTH_DOMAIN`. Unset → first admin-domain login wins |
| `CONFIG_JWKS_URL` | Plain value: `https://authentication.unlikeotherai.com/.well-known/jwks.json`; trusted JWKS URL for RS256 config JWT verification; route-level requirement for config-backed auth |
| `CONFIG_JWKS_JSON` | Secret Manager: `uoa-auth-config-jwks-json`; public JWKS JSON served from `/.well-known/jwks.json`; must contain public keys only |
| `PUBLIC_BASE_URL` | Plain value: `https://authentication.unlikeotherai.com` |
| `DATABASE_URL` | Secret Manager: `uoa-auth-database-url`; runtime connection used for post-context (tenant) DB paths; should point at the `uoa_app` role once RLS M2 is enforced |
| `DATABASE_ADMIN_URL` | Secret Manager: `uoa-auth-database-admin-url`; bootstrap/admin connection used for domain-hash auth, admin routes, auto-onboarding, claim flow, retention pruning, audit log, and `/.well-known/jwks.json`; must connect as a `BYPASSRLS` role (`uoa_admin`). Falls back to `DATABASE_URL` when unset |
| `SHARED_SECRET` | Secret Manager: `uoa-auth-shared-secret` |
| `GOOGLE_CLIENT_ID` | Secret Manager: `uoa-auth-google-client-id` |
| `GOOGLE_CLIENT_SECRET` | Secret Manager: `uoa-auth-google-client-secret` |
| `MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK` | Secret Manager: `uoa-auth-mcp-oauth-access-token-private-jwk`; RS256 private JWK (JSON) for confidential resource tokens and optional public-profile tokens. Its public half is served at `/oauth/jwks.json`; key presence alone does not open public OAuth routes |
| `MCP_OAUTH_PUBLIC_PROFILE_ENABLED` | Plain production value: `false` for the confidential-only Ledger rollout. Set `true` only in a separate reviewed change that also configures the dedicated public profile |
| `MCP_OAUTH_DOMAIN` | Required only when `MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true`; must be a dedicated first-party tenant distinct from `ADMIN_AUTH_DOMAIN` and customer domains |
| `MCP_OAUTH_RESOURCES_SUPPORTED` | Used only by the explicitly enabled public profile; case-sensitive RFC 8707 resource allowlist |
| `TARIFF_SNAPSHOT_PRIVATE_JWK` | Secret Manager: `uoa-auth-tariff-snapshot-private-jwk`; dedicated current RS256 private RSA JWK for signed tariff snapshots. Configure it only with the matching public JWKS; do not reuse another UOA signing key |
| `TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON` | Secret Manager: `uoa-auth-tariff-snapshot-public-jwks-json`; public-only JWKS containing the current tariff key and overlapping retired verification keys. The current entry must exactly match the private key's `kid`, modulus, and exponent |
| `STRIPE_BILLING_ENABLED` | Plain safety gate. Production default is `false`; Stripe and Ledger collection calls are forbidden until every launch prerequisite below is verified |
| `STRIPE_SECRET_KEY` | Secret Manager: dedicated Stripe restricted/live key for UOA billing. Presence alone does not enable billing |
| `STRIPE_WEBHOOK_SECRET` | Secret Manager: Stripe endpoint signing secret for `/billing/v1/stripe/webhook`; never reuse a product app key or Ledger key |
| `STRIPE_USAGE_EXPORT_INTERVAL_MINUTES` | Plain recurring collector interval, 5–1,440 minutes; workflow default 60 |
| `STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES` | Plain horizon in which the additional pre-boundary safety timer is scheduled; workflow default 360 and must cover interval plus offset |
| `STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES` | Plain offset before UTC billing-period end for the safety pass; workflow default 1. This is not the final reconciliation |
| `LEDGER_BILLING_BASE_URL` | Plain credential-free HTTPS Ledger origin, canonical production value `https://ledger.unlikeotherai.com` |
| `LEDGER_BILLING_APP_KEY` | Secret Manager: UOA's own dedicated, product-bound Ledger raw-metering reader app key. Never reuse a Nessie, DeepWater, DeepSignal, DeepTest, user, or webhook credential |
| `LEDGER_BILLING_APP_KEY_ID` | Plain immutable Ledger record ID for that exact UOA app key; copied into the signed assertion's `azp` and verified by Ledger |
| `LEDGER_BILLING_ASSERTION_AUDIENCE` | Exact Ledger service-assertion audience, canonical production value `https://ledger.unlikeotherai.com` |
| `UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK` | Secret Manager: dedicated current RS256 private JWK used only for short-lived UOA→Ledger `metering.read` assertions |
| `UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON` | Secret Manager: public-only current and overlapping retired assertion keys served at `/billing/v1/service-jwks.json`; current public pair must match the private key |

`/llm` is a Markdown integration guide for LLMs and human readers. `/api` is the machine-readable JSON schema and config contract.

The deploy workflow also reads two GitHub repository variables that are not
runtime application config:

* `UOA_STRIPE_BILLING_CONFIGURED` defaults to `false`. Only exact `true`
  attaches the two Stripe Secret Manager entries.
* `STRIPE_BILLING_ENABLED` defaults to `false`. Exact `true` additionally
  requires the configured flag and all Ledger collector identifiers, keeps one
  Cloud Run instance warm, and disables CPU throttling so the recurring
  scheduler and pre-boundary safety timer run. False deploys with zero minimum
  instances and throttled idle CPU.

Tariff-signing, billing-assertion, and UOA's Ledger collector credentials are
wired on every deployment because they are required for signed entitlement and
reconciliation readiness; that does not enable Stripe or create billable
resources.

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
3. Provision Stripe test-mode API and webhook secrets. Configure the webhook for
   Checkout-session and subscription lifecycle events and confirm raw-body
   signature validation plus idempotent replay. The API key must use an explicit
   `sk_test_`/`rk_test_` or `sk_live_`/`rk_live_` prefix; unknown mode fails
   startup. Confirm `/v1/account` resolves the intended Stripe account.
4. Mint a separate `customer_lifecycle` `uoa_app_…` key for each
   product/deployment. Use it for that product's mandatory post-SSO
   `/billing/v1/service-access/confirm` call and customer billing lifecycle;
   bind only its own actor issuer/key and exact HTTPS return origins. Keep its
   `entitlement` key separate and origin-free.
5. Exercise credentialed current-month `group_by=service` and `group_by=user`
   `metering-usage-v1` reads, UOA central rating, monthly fixed charges,
   add-ons/credits, rated-usage deltas, zero and negative corrections,
   lost-response replay, UTC month boundaries, the pre-boundary safety pass,
   and authoritative post-period `invoice.created`
   reconciliation against immutable Ledger cursors. Prove usage in the final
   minute reaches the draft invoice during Stripe's configured finalization
   grace period.
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

### Signature module production prerequisites (not enabled)

The per-domain agreement-signature service remains process-disabled by default and this implementation work does not change the Cloud Run service configuration or enable any production domain. Before production enablement, operators must provision and review all of the following together:

| Variable / dependency | Required production configuration |
|---|---|
| `SIGNATURE_STORAGE_PROVIDER` | `gcs`; local filesystem storage is rejected in production |
| `SIGNATURE_GCS_BUCKET` | Dedicated private bucket with public access prevention, residency/backup/lifecycle policy, and create/read/delete permissions restricted to the Cloud Run service account |
| `SIGNATURE_GCS_PROJECT_ID` | Optional project override when the bucket is outside the runtime project |
| `SIGNATURE_MALWARE_SCANNER` | `clamav`; uploads fail closed while disabled or unavailable |
| `SIGNATURE_CLAMDSCAN_PATH` | Path to the reviewed `clamdscan` client in the runtime image; a reachable, updated ClamAV daemon is also required |
| `SIGNATURE_MALWARE_SCAN_TIMEOUT_MS` | Bounded scan timeout, default 30 seconds |
| `SIGNATURE_EVIDENCE_PRIVATE_JWK` | Secret Manager: dedicated RS256 private RSA JWK with a unique `kid`; never reuse another UOA signing key |
| `SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON` | Public-only current and retired evidence keys; must include the private key's current `kid` |
| `SIGNATURE_MAX_PDF_BYTES` / `SIGNATURE_MAX_PDF_PAGES` | Reviewed operational upload bounds (implementation defaults: 25 MiB / 200 pages) |

Enabling an individual domain additionally requires an explicit retention period and at least one active published required agreement version. Legal retention, bucket residency, encryption-key ownership, evidence-key custody/rotation, ClamAV packaging, and backup policy require an approved production change; they are not inferred from local defaults.

## Service config

- Max instances: 3
- Startup CPU boost: enabled
- Cloud SQL connection: `gen-lang-client-0561071620:europe-west1:uoa-auth-db`

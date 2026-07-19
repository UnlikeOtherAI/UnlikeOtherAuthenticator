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
| `CONFIDENTIAL_TOKEN_EXCHANGE_SOURCE_DOMAIN` | Plain production value: `api.nessie.works`; the only source config domain allowed to use the confidential assertion grant |
| `CONFIDENTIAL_TOKEN_EXCHANGE_RESOURCE` | Plain production value: `https://ledger.unlikeotherai.com`; paired exactly with the source domain and used as the issued token audience |
| `TARIFF_SNAPSHOT_PRIVATE_JWK` | Secret Manager: `uoa-auth-tariff-snapshot-private-jwk`; dedicated current RS256 private RSA JWK for signed tariff snapshots. Configure it only with the matching public JWKS; do not reuse another UOA signing key |
| `TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON` | Secret Manager: `uoa-auth-tariff-snapshot-public-jwks-json`; public-only JWKS containing the current tariff key and overlapping retired verification keys. The current entry must exactly match the private key's `kid`, modulus, and exponent |

`/llm` is a Markdown integration guide for LLMs and human readers. `/api` is the machine-readable JSON schema and config contract.

The private key used to sign `ADMIN_CONFIG_JWT` is not attached to Cloud Run. Store it separately in Secret Manager as `uoa-auth-config-jwt-private-jwk` for rotation/signing operations only.

Before enabling the confidential exchange in production:

1. Create `uoa-auth-mcp-oauth-access-token-private-jwk` as an RSA private JWK
   with `alg=RS256`, a unique `kid`, and public `n`/`e` members; grant both the
   Cloud Run runtime identity and GitHub deployment identity Secret Manager
   accessor permission.
2. Keep `MCP_OAUTH_PUBLIC_PROFILE_ENABLED=false`; confidential signing and JWKS
   publication do not require a public OAuth tenant.
3. Confirm `https://api.nessie.works` publishes its assertion signing public key
   at the `jwks_url` in its config JWT.
4. Verify `GET https://authentication.unlikeotherai.com/oauth/jwks.json` returns
   the configured public key, while discovery, registration, authorize, login,
   and `/oauth/token` return 404, before enabling confidential callers.

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
   tariff through the platform-superuser API.
3. Mint a different named `uoa_app_…` key for every application connection.
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

Stripe customer, subscription, invoice, and webhook configuration is outside
this deployment slice.

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

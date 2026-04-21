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
| `AUTH_SERVICE_IDENTIFIER` | Plain value: `authentication.unlikeotherai.com` |
| `ADMIN_AUTH_DOMAIN` | Plain value: `authentication.unlikeotherai.com` |
| `ADMIN_ACCESS_TOKEN_SECRET` | Secret Manager: `uoa-admin-access-token-secret`; used to sign tokens issued for `ADMIN_AUTH_DOMAIN`; route-level requirement for admin access |
| `ADMIN_CONFIG_JWT` | Secret Manager: `uoa-admin-config-jwt`; signed RS256 config JWT served from `/internal/admin/config`; must disable registration and allow only Google |
| `CONFIG_JWKS_URL` | Plain value: `https://authentication.unlikeotherai.com/.well-known/jwks.json`; trusted JWKS URL for RS256 config JWT verification; route-level requirement for config-backed auth |
| `CONFIG_JWKS_JSON` | Secret Manager: `uoa-auth-config-jwks-json`; public JWKS JSON served from `/.well-known/jwks.json`; must contain public keys only |
| `PUBLIC_BASE_URL` | Plain value: `https://authentication.unlikeotherai.com` |
| `DATABASE_URL` | Secret Manager: `uoa-auth-database-url` |
| `SHARED_SECRET` | Secret Manager: `uoa-auth-shared-secret` |
| `GOOGLE_CLIENT_ID` | Secret Manager: `uoa-auth-google-client-id` |
| `GOOGLE_CLIENT_SECRET` | Secret Manager: `uoa-auth-google-client-secret` |

`/llm` is a Markdown integration guide for LLMs and human readers. `/api` is the machine-readable JSON schema and config contract.

The private key used to sign `ADMIN_CONFIG_JWT` is not attached to Cloud Run. Store it separately in Secret Manager as `uoa-auth-config-jwt-private-jwk` for rotation/signing operations only.

## Service config

- Max instances: 3
- Startup CPU boost: enabled
- Cloud SQL connection: `gen-lang-client-0561071620:europe-west1:uoa-auth-db`

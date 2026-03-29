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
  - builds and pushes the container image to Artifact Registry
  - deploys the new image to Cloud Run service `uoa-auth`
  - checks `https://authentication.unlikeotherai.com/health`

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
| `PUBLIC_BASE_URL` | Plain value: `https://authentication.unlikeotherai.com` |
| `DATABASE_URL` | Secret Manager: `uoa-auth-database-url` |
| `SHARED_SECRET` | Secret Manager: `uoa-auth-shared-secret` |
| `GOOGLE_CLIENT_ID` | Secret Manager: `uoa-auth-google-client-id` |
| `GOOGLE_CLIENT_SECRET` | Secret Manager: `uoa-auth-google-client-secret` |

## Service config

- Max instances: 3
- Startup CPU boost: enabled
- Cloud SQL connection: `gen-lang-client-0561071620:europe-west1:uoa-auth-db`

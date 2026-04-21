import type { FastifyInstance } from 'fastify';

function renderLlmMarkdown(): string {
  return `# UnlikeOtherAuthenticator integration guide

UnlikeOtherAuthenticator (UOA) is a centralized OAuth and authentication service. A client application does NOT post raw configuration to UOA. The client exposes an HTTPS \`config_url\` that returns a signed RS256 config JWT, and UOA fetches and verifies that JWT on every auth request. There is no per-app OAuth client registration in UOA — the trust comes from the signed config JWT alone.

For machine-readable JSON, endpoint schemas, and config contracts, use [/api](/api).

## Two trust mechanisms (do not confuse them)

UOA uses two independent secrets. They cover different things and are stored in completely different places.

| Mechanism | Used for | Where it lives | Cryptography |
|---|---|---|---|
| **RS256 signing key + JWKS** | Signing the config JWT returned by your \`config_url\`. UOA verifies the signature on every fetch. | The PUBLIC JWK is registered with UOA (Phase 0 below). The PRIVATE key stays in your client backend only. | Asymmetric. RS256. UOA never sees the private key. |
| **Per-domain client secret** | Bearer authorization for backend-to-backend calls (\`/auth/token\`, \`/auth/revoke\`, \`/domain/*\`, etc.). | Created in the UOA Admin UI under **Configuration > Secrets** for one specific domain. Shown once. | Symmetric. \`SHA256(domain + clientSecret)\` is the bearer token. UOA stores only an HMAC digest of that hash. |

You need BOTH to ship a working integration. Phase 0 + Phase 1 below cover them in order.

## Service discovery

- Home: [/](./)
- Admin UI: [/admin](/admin)
- LLM guide: [/llm](/llm) (this page)
- JSON API schema: [/api](/api)
- Config JWKS (RS256 public keys UOA accepts): [/.well-known/jwks.json](/.well-known/jwks.json)
- Health check: [/health](/health)
- Production-safe config validator: \`POST /config/validate\`
- DEBUG-only validator with custom JWKS: \`POST /config/verify\` (only when \`DEBUG_ENABLED=true\` and \`NODE_ENV !== 'production'\`)

---

## Phase 0 — Register your RS256 signing key with UOA

You cannot skip this. Until your public JWK is in UOA's \`CONFIG_JWKS_JSON\` document, every \`/auth\` request will fail with \`CONFIG_JWT_INVALID\` because UOA cannot resolve your \`kid\`.

### 0.1 Generate an RSA-2048 keypair

OpenSSL:

\`\`\`bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out config-signing.private.pem
openssl rsa -in config-signing.private.pem -pubout -out config-signing.public.pem
\`\`\`

Node (\`jose\` ≥ 5):

\`\`\`js
import { generateKeyPair, exportJWK } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = 'voicepos-2026-04';   // pick a stable ID; rotate by adding a NEW kid, never reuse
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';
console.log(JSON.stringify(publicJwk, null, 2));
\`\`\`

### 0.2 Required public JWK shape

UOA's JWKS validator accepts ONLY these members and REJECTS the document if any private members are present.

\`\`\`json
{
  "kty": "RSA",
  "kid": "voicepos-2026-04",
  "alg": "RS256",
  "use": "sig",
  "n": "<base64url modulus>",
  "e": "AQAB"
}
\`\`\`

- \`kty\` MUST be \`"RSA"\`. EC, OKP, and oct keys are rejected.
- \`kid\` MUST be a non-empty string and MUST be unique within UOA's JWKS.
- \`n\` and \`e\` MUST be non-empty base64url strings.
- \`alg\` SHOULD be \`"RS256"\` (the only algorithm UOA accepts for config JWTs).
- The following members are FORBIDDEN and will cause UOA to reject the JWKS at boot: \`d\`, \`p\`, \`q\`, \`dp\`, \`dq\`, \`qi\`, \`oth\`. Never paste a private key.

### 0.3 Send the public JWK to a UOA superuser

Email or share the JWK JSON above with a UOA superuser. Today the JWKS document is loaded from the deployment env var \`CONFIG_JWKS_JSON\` and served at \`/.well-known/jwks.json\`. A superuser appends your JWK to the \`keys\` array, redeploys UOA, and confirms your \`kid\` shows up in the JWKS.

You can verify your registration any time with:

\`\`\`bash
curl https://<uoa-host>/.well-known/jwks.json | jq '.keys[] | .kid'
\`\`\`

Your new \`kid\` MUST appear in that list before Phase 2 will work.

### 0.4 Store the private key in your client backend ONLY

The private PEM (or \`privateKey\` from \`jose.generateKeyPair\`) lives in your application backend's secret store. It must NEVER be committed to git, sent to UOA, or accessible from a browser. Rotate by generating a new key with a new \`kid\`, registering it, and signing new config JWTs with the new \`kid\` — keep the old \`kid\` in the JWKS until all caches expire (UOA caches the JWKS for ~10 minutes).

---

## Phase 1 — Get your per-domain client secret

Backend calls to UOA (token exchange, token revoke, domain admin APIs) authenticate with a per-domain bearer token. You get the underlying client secret from the UOA Admin UI.

1. Open **/admin** and sign in as a UOA superuser (or ask one).
2. Go to **Configuration > Secrets**.
3. Click **Add Domain**, enter the domain hostname (must equal the \`domain\` claim you will put in the config JWT, e.g. \`api.voicepos.unlikeotherai.com\`), a friendly label, and either generate or paste a 36-byte base64url client secret.
4. Submit. The next screen reveals \`client_secret\` and \`client_hash\` ONCE. Copy both into your backend secret store immediately. After this dialog closes, the secret cannot be retrieved — only rotated.

**What UOA stores.** UOA never persists the raw secret. The \`client_domains\` table holds the domain row, and \`client_domain_secrets\` holds an HMAC-SHA256 digest of \`SHA256(domain + clientSecret)\` plus a 16-character display prefix used to identify the active secret in the admin UI. The digest is keyed with the deployment-wide \`SHARED_SECRET\` env var. There is no decryption path.

**Computing the bearer token from the client secret.** If you only stored \`client_secret\`, recompute the bearer at runtime:

\`\`\`js
import { createHash } from 'node:crypto';
const clientHash = createHash('sha256').update(domain + clientSecret).digest('hex'); // 64 hex chars
// Authorization: Bearer <clientHash>
\`\`\`

**Rotation.** In **Configuration > Secrets**, click **Rotate** on a domain row. UOA generates a new secret, deactivates the previous one, and reveals the new \`client_secret\`/\`client_hash\` once. Update the client backend immediately — the previous bearer stops working as soon as the rotation completes.

**Disabling.** \`Disable\` on a domain row sets its status to \`disabled\`; UOA rejects every domain bearer request for that domain until it is re-enabled.

---

## Phase 2 — Implement your \`config_url\` endpoint

Expose a public HTTPS GET endpoint on the SAME hostname you registered as the domain. UOA fetches it server-side on every \`/auth\` request.

### 2.1 Network requirements UOA enforces

- HTTPS only. HTTP, file, ftp, gopher schemes are rejected.
- Public DNS only. UOA resolves the hostname and rejects loopback, link-local, RFC1918 private ranges, IPv4-mapped IPv6, NAT64, multicast, and unspecified addresses. Cloud Run egress will reach you over public internet — your endpoint must be reachable from there.
- Hard timeout: 5 seconds end-to-end including redirects.
- Max 3 redirects. Each hop is re-validated with the same SSRF rules.
- Max response body: 64 KiB. Anything larger is rejected.
- UOA sends \`Accept: text/plain, application/json\` and \`User-Agent: UnlikeOtherAuthenticator/config-fetch/<version>\`.

### 2.2 Accepted response formats

UOA accepts ANY of these as the body of a \`200 OK\` response. Pick whichever is easiest:

1. **Bare JWT** (preferred): the response body is the JWT compact serialization, three base64url segments separated by dots. \`Content-Type: application/jwt\` or \`text/plain\`.
2. **\`Bearer <jwt>\`**: the body starts with the literal string \`Bearer \` followed by the JWT.
3. **JSON envelope**: \`{ "jwt": "<jwt>" }\` — the field name may be \`jwt\`, \`token\`, \`config_jwt\`, \`configJwt\`, or \`configJWT\`. \`Content-Type: application/json\`.

Anything else (HTML, error JSON, empty body) fails with \`CONFIG_FETCH_FAILED\`.

### 2.3 Required JWT header

\`\`\`json
{ "alg": "RS256", "kid": "voicepos-2026-04", "typ": "JWT" }
\`\`\`

- \`alg\` MUST be exactly \`"RS256"\`. \`HS256\`, \`none\`, \`ES256\`, \`PS256\`, etc. are rejected.
- \`kid\` MUST be present, non-empty, and MUST resolve in UOA's JWKS (Phase 0). If your \`kid\` is missing or not yet in UOA's JWKS the request fails with \`CONFIG_JWT_INVALID\`.
- \`typ\` is optional but recommended.

### 2.4 Required payload fields

\`\`\`json
{
  "domain": "api.voicepos.unlikeotherai.com",
  "redirect_urls": ["https://app.voicepos.unlikeotherai.com/oauth/callback"],
  "enabled_auth_methods": ["email_password", "google"],
  "ui_theme": { "...": "see /api for the full ui_theme contract" },
  "language_config": "en"
}
\`\`\`

- \`domain\` MUST exactly equal the hostname of the \`config_url\` UOA fetched. Mismatch fails with \`CONFIG_DOMAIN_MISMATCH\`.
- \`redirect_urls\` MUST be a non-empty array of absolute HTTP/HTTPS URLs. Matching at \`/auth\` is exact (scheme + host + port + path + query).
- \`enabled_auth_methods\` MUST be a non-empty array. Allowed values: \`email_password\`, \`google\`, \`facebook\`, \`github\`, \`linkedin\`, \`apple\`. There is no separate social-provider allowlist — listing a provider here both enables and allows it.
- \`ui_theme\` is required. See \`/api\` for the full contract (colors as hex only, radii/font sizes as CSS lengths, button + card styles, logo with required \`url\` and \`alt\`).
- \`language_config\` is one IETF code or a non-empty array of codes.

The payload MUST NOT contain \`SHARED_SECRET\`, the \`client_secret\` from Phase 1, the \`client_hash\`, refresh tokens, OAuth codes, or any other secret. UOA scans for known secret patterns and refuses the config if it sees one.

Optional fields are documented at \`/api\` under \`config_jwt_documentation.optional_fields\`, including \`2fa_enabled\`, \`debug_enabled\`, \`user_scope\`, \`allow_registration\`, \`registration_mode\`, \`allowed_registration_domains\`, \`registration_domain_mapping\`, \`session.*\`, \`org_features.*\`, and \`access_requests.*\`.

### 2.5 Sign the JWT

\`\`\`js
import { SignJWT, importPKCS8 } from 'jose';

const privateKey = await importPKCS8(process.env.UOA_CONFIG_SIGNING_PRIVATE_KEY_PEM, 'RS256');
const jwt = await new SignJWT(payload)
  .setProtectedHeader({ alg: 'RS256', kid: 'voicepos-2026-04', typ: 'JWT' })
  .setIssuedAt()
  .sign(privateKey);
return new Response(jwt, { headers: { 'content-type': 'application/jwt' } });
\`\`\`

Do NOT cache the JWT for long (UOA fetches every request and caches the JWKS for ~10 minutes). Re-signing per request is fine; the limit is 5 seconds per fetch.

---

## Phase 3 — Trigger the auth flow

Open the auth UI from the browser:

\`\`\`text
GET /auth?config_url=<your_config_endpoint_url>
        &redirect_url=<your_callback_url>
        &code_challenge=<S256_challenge>
        &code_challenge_method=S256
\`\`\`

- \`config_url\` is the HTTPS endpoint from Phase 2. UOA URL-decodes it before fetching.
- \`redirect_url\` MUST appear EXACTLY in \`redirect_urls\` from Phase 2's payload.
- PKCE is mandatory: generate a random 43-128 char \`code_verifier\`, hash it with SHA-256, base64url-encode, and pass as \`code_challenge\`. \`code_challenge_method\` MUST be \`S256\`.

After the user authenticates, UOA redirects to \`<redirect_url>?code=<authorization_code>\`. The code is single-use and short-lived; treat it as sensitive.

---

## Phase 4 — Backend token exchange

This call is server-to-server. The browser MUST never see the bearer token.

\`\`\`text
POST /auth/token?config_url=<your_config_endpoint_url>
Authorization: Bearer <client_hash from Phase 1>
Content-Type: application/json

{
  "code": "<authorization_code>",
  "redirect_url": "<same callback URL used in Phase 3>",
  "code_verifier": "<the PKCE verifier whose SHA-256 produced code_challenge>"
}
\`\`\`

Response contains an access token, a refresh token, expiry metadata, and the user profile. Store the refresh token server-side ONLY; browser clients never receive or persist refresh tokens.

To revoke on logout:

\`\`\`text
POST /auth/revoke?config_url=<your_config_endpoint_url>
Authorization: Bearer <client_hash>
Content-Type: application/json

{ "refresh_token": "<refresh token to revoke>" }
\`\`\`

Domain admin APIs (\`/domain/users\`, \`/domain/logs\`, etc.) and team-invite / access-request review APIs use the same \`Authorization: Bearer <client_hash>\` mechanism. The old global shared-secret bearer is NOT accepted for any customer-facing endpoint.

---

## Validate at every step

UOA ships a production-safe validator that runs the same pipeline as the auth runtime:

\`\`\`text
POST /config/validate
Content-Type: application/json

{ "config_url": "https://api.voicepos.unlikeotherai.com/auth/config" }
\`\`\`

Body may instead be \`{ "config_jwt": "<jwt>" }\` or \`{ "config": { ... raw payload ... } }\`. Source priority is \`config\` > \`config_jwt\` > \`config_url\`.

The response includes:

- \`ok\`: every executed check passed.
- \`checks\`: per-stage results for \`source\`, \`fetch\`, \`decode\`, \`secret_scan\`, \`signature\`, \`schema\`, \`runtime_policy\`, \`domain_match\`.
- \`issues\`: structured failures with stage, code, summary, details.
- \`recommendations\`: required next steps and optional customization guidance (logo, custom font, language selector, token TTL, org features, access requests).
- \`config_summary\`: a safe parsed summary when schema validation succeeds.

In a non-production deployment with \`DEBUG_ENABLED=true\` you can additionally pass \`jwks_url\` to \`POST /config/verify\` to verify against a JWKS other than \`CONFIG_JWKS_URL\` — useful for testing a new \`kid\` before it is registered with the production UOA.

---

## Errors and what they actually mean

| Error code | Stage | Almost-always cause |
|---|---|---|
| \`CONFIG_FETCH_FAILED\` | UOA fetching your \`config_url\` | Endpoint unreachable from UOA, returned non-200, returned > 64 KiB, took > 5s, returned a body that did not contain a recognizable JWT, or resolved to a private/blocked IP. Check the **Connection Errors** page in /admin for the captured request/response context. |
| \`CONFIG_URL_NETWORK_ERROR\` | UOA fetching your \`config_url\` | TLS, DNS, or socket-level failure before HTTP could complete. |
| \`CONFIG_JWT_INVALID\` | Header / signature verification | Almost always: your \`kid\` is not yet in UOA's \`CONFIG_JWKS_JSON\` (Phase 0 not completed or not redeployed). Other causes: \`alg\` is not \`RS256\`, \`kid\` missing, signature does not match the registered public key, JWKS endpoint unreachable. |
| \`CONFIG_DOMAIN_MISMATCH\` | Post-decode | \`payload.domain\` does not exactly match the hostname of the \`config_url\` UOA fetched. Hostnames are compared case-insensitively but must otherwise be identical (no trailing dot, no port mismatch). |
| Schema validation failures | Schema stage | A required field is missing or malformed. \`/config/validate\` returns the exact JSON path and reason in \`issues\`. |
| \`auth_failed\` (final redirect) | Post-callback | Intentionally generic. With \`allow_registration: false\`, social login does not create users — the user must already exist for that domain. Check \`/internal/admin/handshake-errors\`. |
| Google \`redirect_uri_mismatch\` | Provider | Your Google OAuth client does not list the exact callback URL UOA generated from \`PUBLIC_BASE_URL\` + \`/auth/callback/google\`. |

For deep diagnostics of failed \`/auth\` requests, a UOA superuser can open **/admin > Security > Connection Errors**. UOA records the sanitized request/response context for handshake failures, including JWT header/payload (with secrets redacted), the failing phase, and the resolved \`config_url\`.

---

## What NOT to do

- Do NOT use HS256 or any algorithm other than RS256. UOA rejects everything else.
- Do NOT reuse a \`kid\` after rotation. Always pick a new \`kid\`.
- Do NOT put \`client_secret\`, \`client_hash\`, \`SHARED_SECRET\`, refresh tokens, or OAuth codes into the config JWT payload.
- Do NOT call \`/auth/token\` or \`/auth/revoke\` from the browser. The bearer is backend-only.
- Do NOT host \`config_url\` on a private DNS name, internal load balancer, loopback, or VPN-only host. UOA fetches over the public internet and rejects private IPs.
- Do NOT assume a \`200\` from your \`config_url\` in a browser implies UOA can fetch it — UOA enforces SSRF rules a browser does not.
- Do NOT replay OAuth \`code\` values from logs or chat. They are one-time credentials.
- Do NOT skip \`/config/validate\` before pointing real users at UOA.

---

## Admin access

The first-party Admin UI is served from [/admin](/admin). It dogfoods the same auth system with its own first-party config:

- \`/admin/login\` redirects into \`/auth\` with PKCE.
- The admin config is served from \`/internal/admin/config\` and verified against the public JWKS at \`/.well-known/jwks.json\`.
- The admin config uses the admin domain, disables registration, and allows only Google.
- \`/admin/auth/callback\` exchanges the authorization code at \`POST /internal/admin/token\`.
- Admin access tokens are signed with \`ADMIN_ACCESS_TOKEN_SECRET\`.
- Only \`role: "superuser"\` tokens for \`ADMIN_AUTH_DOMAIN\` can access \`/internal/admin/*\`.
- \`ADMIN_AUTH_DOMAIN\` defaults to the resolved auth service identifier (inferred from \`PUBLIC_BASE_URL\` unless \`AUTH_SERVICE_IDENTIFIER\` overrides it).
- DB-backed deployments also require a \`SUPERUSER\` row in \`domain_roles\` for that admin domain.

---

## Operational endpoints

- \`GET /domain/users\` — list users for a domain.
- \`GET /domain/logs\` — domain login logs.
- \`GET /org/me\` — current user's org context.
- \`GET /internal/admin/handshake-errors\` — sanitized handshake and config JWT errors for superusers, including redacted request/response context when \`config_url\` fetches fail before a JWT can be decoded.

Use [/api](/api) for the complete JSON endpoint schema and the canonical \`config_jwt\` field contract.`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

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

## Phase 0 — Generate your RS256 signing keypair

Every config JWT is RS256-signed. You need an RSA-2048 keypair whose PUBLIC JWK is discoverable at a JWKS URL UOA can fetch, and whose PRIVATE key stays in your backend.

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
- \`kid\` MUST be a non-empty string. It MUST be unique across all JWKs registered to your \`domain\`, and collisions with other partners' \`kid\`s are rejected.
- \`n\` and \`e\` MUST be non-empty base64url strings.
- \`alg\` SHOULD be \`"RS256"\` (the only algorithm UOA accepts for config JWTs).
- The following members are FORBIDDEN and will cause UOA to reject the JWK: \`d\`, \`p\`, \`q\`, \`dp\`, \`dq\`, \`qi\`, \`oth\`. Never paste a private key.

### 0.3 Store the private key in your client backend ONLY

The private PEM (or \`privateKey\` from \`jose.generateKeyPair\`) lives in your application backend's secret store. It must NEVER be committed to git, sent to UOA, or accessible from a browser. Rotate by generating a new key with a new \`kid\`, publishing it on your JWKS URL, and signing new config JWTs with the new \`kid\` — keep the old \`kid\` published until all caches expire (UOA caches the JWKS for ~10 minutes).

---

## Phase 1 — Auto-onboard with one \`/auth\` call

UOA uses **auto-onboarding**. There is no admin-side "Add Domain" button anymore; you register yourself by making one \`/auth\` call with a config JWT that contains two extra payload fields. A UOA superuser then sees your request in the admin console, approves it, and UOA emails you a one-time claim link.

### 1.1 Publish your JWKS URL on the SAME hostname as your \`config_url\`

Stand up a public HTTPS endpoint that returns a standard JWKS document with your public JWK:

\`\`\`http
GET https://api.voicepos.unlikeotherai.com/.well-known/jwks.json

{ "keys": [ { "kty": "RSA", "kid": "voicepos-2026-04", "alg": "RS256", "use": "sig", "n": "...", "e": "AQAB" } ] }
\`\`\`

- Hostname of \`jwks_url\` MUST equal the \`domain\` claim in your config JWT (case-insensitive). Cross-host JWKS are rejected with \`INTEGRATION_JWKS_HOST_MISMATCH\`.
- Same SSRF rules as \`config_url\`: HTTPS only, public DNS only, 5s timeout, 64 KiB cap, 3 redirects max.

### 1.2 Include \`jwks_url\` and \`contact_email\` in your config JWT payload

Add two optional fields to the payload described in Phase 2.4. These are only required on the auto-onboarding call; after approval they are inert but harmless.

\`\`\`json
{
  "domain": "api.voicepos.unlikeotherai.com",
  "jwks_url": "https://api.voicepos.unlikeotherai.com/.well-known/jwks.json",
  "contact_email": "ops@voicepos.com",
  "redirect_urls": ["https://app.voicepos.unlikeotherai.com/oauth/callback"],
  "enabled_auth_methods": ["email_password", "google"],
  "ui_theme": { "...": "see /api" },
  "language_config": "en"
}
\`\`\`

### 1.3 Make ONE \`/auth\` call to trigger auto-discovery

Open \`/auth?config_url=<your_config_url>&redirect_url=<callback>&code_challenge=<S256>&code_challenge_method=S256\` in a browser. UOA will:

1. Fetch and decode your config JWT (unverified) to read \`jwks_url\` and \`contact_email\`.
2. Verify \`URL(jwks_url).hostname === payload.domain\`.
3. Fetch \`jwks_url\` through the same SSRF-protected pipeline as \`config_url\`.
4. Verify the config JWT signature against the published public JWK.
5. Schema-validate the payload so it can store a safe \`config_summary\`.
6. Insert a PENDING row in \`client_domain_integration_requests\` (or touch the existing one).
7. Render a friendly **"Integration pending review"** page. No auth flow runs yet.

The browser now shows the pending page. Do not retry in a loop — UOA has everything it needs.

### 1.4 Wait for the approval email

A UOA superuser sees your request in **/admin > New Integrations**, inspects the fingerprint, \`jwks_url\`, and verified \`config_summary\`, and clicks **Accept**. UOA:

- Creates the \`client_domains\` row, the first \`client_domain_jwks\` row, and a new client secret inside one DB transaction.
- **Delivers the credentials one of two ways** depending on what the superuser picked on Accept:
  - **Email claim link (default):** \`contact_email\` receives a link of the form \`https://<uoa-host>/integrations/claim/<token>\`. The token is single-use and expires after 24 hours. You claim the secret yourself.
  - **Reveal to admin:** the superuser sees \`domain\`, \`client_secret\`, \`client_hash\`, and \`hash_prefix\` once in the admin UI and passes them to you through your own secure channel. No email is sent.

If the superuser declines, no email is sent. Contact your UOA superuser if you expected approval but did not receive an email (or a secret from them directly) within a business day.

### 1.5 Open the claim link and copy the secret ONCE

1. Open the claim link in a browser. You will see a "Confirm" page — link scanners and email previewers cannot burn the token because consumption requires a \`POST\`.
2. Click **Reveal secret**. UOA POSTs to \`/integrations/claim/:token/confirm\`, marks the token used, and renders the one-time reveal page containing \`domain\`, \`client_secret\`, \`client_hash\`, and \`hash_prefix\`.
3. Copy \`client_secret\` and \`client_hash\` into your backend secret store immediately. The page warns "This is the only time this secret will be displayed." Refreshing or re-opening the link returns the invalid-link page.

**What UOA stores.** UOA never persists the raw secret. \`client_domains\` holds the domain row, and \`client_domain_secrets\` holds an HMAC-SHA256 digest of \`SHA256(domain + clientSecret)\` keyed with the deployment-wide \`SHARED_SECRET\`, plus a 16-character display prefix used to identify the active secret in the admin UI. There is no decryption path.

**Computing the bearer token from the client secret.** If you only stored \`client_secret\`, recompute the bearer at runtime:

\`\`\`js
import { createHash } from 'node:crypto';
const clientHash = createHash('sha256').update(domain + clientSecret).digest('hex'); // 64 hex chars
// Authorization: Bearer <clientHash>
\`\`\`

**Resend claim link.** If you lose the email before clicking, ask a UOA superuser to use **Resend claim link** on the accepted request. The old token is revoked and a fresh one is emailed (or revealed in-UI if the superuser picks reveal mode on resend).

**Disabling.** A superuser can set a domain to \`disabled\` on the Secrets page; UOA rejects every domain bearer request for that domain until it is re-enabled.

### 1.6 Adding or deactivating signing keys later

Once your domain is registered, a superuser can add additional RSA JWKs through **Admin > Secrets > domain > Signing Keys**, or deactivate an old \`kid\`. Rotation flow: publish the new \`kid\` on your JWKS URL, ask a superuser to register it, start signing with the new \`kid\`, and once traffic with the old \`kid\` drains the superuser deactivates the old row.

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
- \`kid\` MUST be present, non-empty, and MUST resolve to a registered JWK — either a \`client_domain_jwks\` row for your domain, or the legacy deployment-wide \`CONFIG_JWKS_JSON\`. On the FIRST \`/auth\` call from a new domain the \`kid\` will not yet be registered; that is the signal that triggers auto-discovery against your \`jwks_url\` (see Phase 1). All subsequent calls must use a \`kid\` that resolves directly in UOA's tables — otherwise the request fails with \`CONFIG_JWT_INVALID\`.
- \`typ\` is optional but recommended.

### 2.4 Required payload fields

\`\`\`json
{
  "domain": "api.voicepos.unlikeotherai.com",
  "jwks_url": "https://api.voicepos.unlikeotherai.com/.well-known/jwks.json",
  "contact_email": "ops@voicepos.com",
  "redirect_urls": ["https://app.voicepos.unlikeotherai.com/oauth/callback"],
  "enabled_auth_methods": ["email_password", "google"],
  "ui_theme": { "...": "see /api for the full ui_theme contract" },
  "language_config": "en"
}
\`\`\`

- \`domain\` MUST exactly equal the hostname of the \`config_url\` UOA fetched. Mismatch fails with \`CONFIG_DOMAIN_MISMATCH\`.
- \`jwks_url\` and \`contact_email\` are **required on the first auto-onboarding call** and optional thereafter. \`jwks_url\` MUST be HTTPS and share the hostname of \`domain\`. \`contact_email\` is where UOA sends the one-time claim link on approval. See Phase 1 for the full flow.
- \`redirect_urls\` MUST be a non-empty array of absolute HTTP/HTTPS URLs. The runtime \`redirect_url\` must match one of these entries **byte-for-byte**, including scheme, host, port, path, AND query string. No normalization, no prefix matching, no query wildcards. If you need to propagate per-request CSRF / PKCE state, carry it out-of-band (\`sessionStorage\`, first-party cookie) — never on the URL. See Phase 3.1.
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

### 3.1 Carrying CSRF / PKCE state across the callback

\`redirect_url\` is matched byte-for-byte against \`config.redirect_urls\`, **including the query string**. If you normally round-trip OAuth state as a query parameter (\`?state=…\`), UOA will reject the request with \`REDIRECT_URL_NOT_ALLOWED\`.

Pick one of these transports instead:

- **\`sessionStorage\` (recommended).** On \`/start\`, return the opaque state token alongside the redirect URL. Stash it in \`sessionStorage\` under a provider-scoped key, then read-and-delete on the callback page before POSTing to your token-exchange endpoint. Binds the token to the originating tab and avoids URL mutation.
- **First-party cookie.** Set a \`__Host-sso_state\` cookie with \`SameSite=Lax; Secure; HttpOnly; Path=/auth/callback\`. Works across full page reloads; requires a same-origin callback.
- **Fragment (\`#state=…\`).** Only viable if the callback is a SPA; the browser strips fragments before the request hits UOA, so UOA won't see it. Fragile and easy to misuse — prefer \`sessionStorage\`.

Do NOT append \`state\` (or any per-request query parameter) to \`redirect_url\`. The allowlist match is exact, and every added byte will be rejected.

**Worked example — sessionStorage round-trip.**

\`\`\`ts
// /start — backend returns the redirect URL and an opaque state token separately.
// GET https://app.example.com/sso/start -> { redirectUrl, stateToken }

// Caller (Admin UI):
const { redirectUrl, stateToken } = await fetch('/sso/start').then((r) => r.json());
sessionStorage.setItem('sso:state:google', stateToken);
window.location.assign(redirectUrl); // redirectUrl == one of config.redirect_urls, verbatim

// /auth/callback — UOA has appended ?code=… to the exact allowlisted URL.
const code = new URLSearchParams(window.location.search).get('code');
const stateToken = sessionStorage.getItem('sso:state:google');
sessionStorage.removeItem('sso:state:google'); // read-and-delete: single use

await fetch('/sso/exchange', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, stateToken }), // backend validates stateToken, then calls POST /auth/token
});
\`\`\`

The backend validates \`stateToken\` against whatever it issued in \`/start\` (short TTL, single use, bound to session) before calling \`POST /auth/token\`. The state token never touches \`redirect_url\`.

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
| \`CONFIG_JWT_INVALID\` | Header / signature verification | Your \`kid\` is not registered and your payload does not include \`jwks_url\` + \`contact_email\` to trigger auto-discovery. Other causes: \`alg\` is not \`RS256\`, \`kid\` missing, signature does not match the registered public key, JWKS endpoint unreachable. |
| \`INTEGRATION_JWKS_HOST_MISMATCH\` | Auto-discovery | The hostname of the \`jwks_url\` you published in the payload does not match the \`domain\` claim (case-insensitive). Fix: host the JWKS on the same hostname. |
| \`INTEGRATION_KID_NOT_IN_JWKS\` | Auto-discovery | UOA fetched your \`jwks_url\` but the JWT's \`kid\` is not present in the document. Fix: publish the correct public JWK with the \`kid\` you signed with. |
| \`INTEGRATION_PENDING_REVIEW\` | Auto-discovery | A valid request has been captured and is waiting for a UOA superuser to approve. Wait for the email to \`contact_email\`; do not retry in a loop. |
| \`INTEGRATION_DECLINED\` | Auto-discovery | A UOA superuser declined your integration request for this domain. Contact support. |
| \`CONFIG_DOMAIN_MISMATCH\` | Post-decode | \`payload.domain\` does not exactly match the hostname of the \`config_url\` UOA fetched. Hostnames are compared case-insensitively but must otherwise be identical (no trailing dot, no port mismatch). |
| \`REDIRECT_URL_NOT_ALLOWED\` | \`/auth\` + \`/auth/token\` | \`redirect_url\` is not in \`config.redirect_urls\`. **Common cause:** the bare URL is allowlisted but a per-request \`?state=…\` (or any query parameter) was appended — matching is byte-for-byte including the query string. Carry state out-of-band (see Phase 3.1), do not mutate the URL. |
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
- Do NOT append \`?state=…\` (or any per-request query) to \`redirect_url\`. The allowlist match is byte-for-byte; your \`/start\` endpoint must return the state token **separately** so the caller can stash it in \`sessionStorage\` or a first-party cookie. See Phase 3.1.

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

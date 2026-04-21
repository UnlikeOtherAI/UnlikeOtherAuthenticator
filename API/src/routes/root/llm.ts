import type { FastifyInstance } from 'fastify';

function renderLlmMarkdown(): string {
  return `# UnlikeOtherAuthenticator integration guide

UnlikeOtherAuthenticator is a centralized OAuth and authentication service. Client applications do not post raw configuration to the service. They expose a HTTPS \`config_url\` that returns a signed RS256 config JWT, and the auth service fetches and verifies that JWT on every auth request.

For machine-readable JSON, endpoint schemas, and config contracts, use [/api](/api).

## Service discovery

- Home: [/](./)
- Admin UI: [/admin](/admin)
- LLM guide: [/llm](/llm)
- JSON API schema: [/api](/api)
- Config JWKS: [/.well-known/jwks.json](/.well-known/jwks.json)
- Health check: [/health](/health)

## Core auth flow

1. Create a backend endpoint on your application that returns a signed config JWT.
2. The JWT header must use \`alg: "RS256"\` and include a \`kid\` that resolves through the configured JWKS.
3. The JWT payload \`domain\` must match the hostname of \`config_url\`.
4. Open the auth UI with:

\`\`\`text
GET /auth?config_url=<your_config_endpoint_url>&redirect_url=<your_callback_url>&code_challenge=<S256_challenge>&code_challenge_method=S256
\`\`\`

5. After the user authenticates, this service redirects to your \`redirect_url\` with \`?code=<authorization_code>\`.
6. Your backend exchanges the code:

\`\`\`text
POST /auth/token?config_url=<your_config_endpoint_url>
Authorization: Bearer SHA256(domain + domain_client_secret)
Content-Type: application/json

{
  "code": "<authorization_code>",
  "redirect_url": "<same callback URL used for login>",
  "code_verifier": "<PKCE verifier>"
}
\`\`\`

7. Store refresh tokens server-side only. Browser clients must not receive or persist refresh tokens.
8. Revoke refresh tokens on logout with \`POST /auth/revoke\`.

## Validate before integrating

Start by reading the machine-readable schema at [/api](/api), then use the production-safe validator before wiring the app into a real login flow:

\`\`\`text
POST /config/validate
Content-Type: application/json

{
  "config_url": "https://client.example.com/auth-config"
}
\`\`\`

It can also accept \`config_jwt\` or raw \`config\`. A \`config_url\` is the best final check because the auth service performs the same server-side fetch, JWT decode, JWKS signature check, schema validation, domain match, runtime policy checks, and customization guidance.

The response includes:

- \`ok\`: whether the configuration is ready for the auth runtime.
- \`checks\`: stage-by-stage results for source, fetch, decode, secret_scan, signature, schema, runtime_policy, and domain_match.
- \`issues\`: blocking problems with stage, code, summary, and details.
- \`recommendations\`: required next steps, operational notes, and optional customizations such as logo URL, custom font, language selector, token TTL, org features, and access requests.

## SSO installation checklist

Use this checklist when installing a new app as an SSO client:

- The client app must expose a public HTTPS \`config_url\`; loopback, private IP, and internal-only DNS targets are rejected.
- The \`domain\` claim in the config JWT must exactly match the hostname of \`config_url\`.
- The config JWT must be signed with RS256, include a \`kid\`, and verify against the auth service \`CONFIG_JWKS_URL\`.
- The JWKS must publish only public key material. Never expose a private JWK, client secret, shared secret, refresh token, or OAuth code.
- \`PUBLIC_BASE_URL\` must be the real external origin of the auth service. Provider callbacks are built from it, for example \`/auth/callback/google\`.
- OAuth provider dashboards must allow the exact callback URLs produced by this service.
- Every \`redirect_url\` sent to \`/auth\` must be listed exactly in \`redirect_urls\`.
- Browser clients must use PKCE. The same \`redirect_url\` and \`code_verifier\` must be used during token exchange.
- Backend token exchange and revoke calls must use the domain-hash Authorization header, never browser credentials.
- Domain-hash Authorization is now backed by per-domain client secrets from Admin > Domains & Secrets. The old global shared secret is not accepted for customer/domain bearer auth.
- If any social provider is listed in \`enabled_auth_methods\`, it must also be listed in \`allowed_social_providers\`.
- If \`allow_registration=false\`, social login will not create a user. The user must already exist or the callback redirects with a generic \`auth_failed\`.
- For org/team installs, decide whether the user can sign in without an assigned team before enabling \`org_features.user_needs_team\`.

## What not to assume during setup

- Do not assume the first successful \`/auth\` page means the full callback path is configured. The callback re-validates config after the provider returns.
- Do not assume a config endpoint reachable from a browser is reachable from Cloud Run or from the auth service. Check DNS, TLS, and private-address rejection.
- Do not assume Google login can register users when registration is disabled for a client config.
- Do not assume admin login uses a separate identity system. The Admin UI uses this same auth system with a first-party config and stricter superuser checks.
- Do not assume provider callback errors will reveal secrets or detailed causes to users. Production pages are intentionally generic; use logs and sanitized handshake-error reporting.
- Do not replay OAuth \`code\` values from logs or chat. They are one-time credentials and should be treated as sensitive.

## Common setup failures

- \`Request failed\` after returning from Google usually means the callback route rejected social state, config fetch, config JWT verification, redirect URL validation, or social-login policy. Check server logs around \`/auth/callback/google\`.
- \`CONFIG_FETCH_FAILED\` means the service could not fetch a usable config JWT from \`config_url\`, or a first-party config was not handled locally.
- \`CONFIG_JWT_INVALID\` means the JWT signature, \`kid\`, algorithm, or JWKS lookup failed.
- \`CONFIG_DOMAIN_MISMATCH\` means the JWT \`domain\` does not match the \`config_url\` hostname.
- \`auth_failed\` on the final redirect is intentionally generic. With \`allow_registration=false\`, first check whether the user already exists and is permitted for that domain.
- Google \`redirect_uri_mismatch\` means the provider dashboard does not contain the exact callback URL built from \`PUBLIC_BASE_URL\`.

## Required config JWT fields

- \`domain\`: client domain. It must match the hostname of \`config_url\`.
- \`redirect_urls\`: non-empty list of exact callback URLs.
- \`enabled_auth_methods\`: non-empty list. Supported values are \`email_password\`, \`google\`, \`facebook\`, \`github\`, \`linkedin\`, and \`apple\`.
- \`ui_theme\`: colors, radii, typography, button, card, and logo configuration.
- \`language_config\`: one language code or a non-empty array of language codes.

## Important optional config fields

- \`allowed_social_providers\`: social providers allowed by this client config.
- \`allow_registration\`: set to \`false\` to block new user creation, including social-login user creation.
- \`registration_mode\`: \`password_required\` or \`passwordless\`.
- \`allowed_registration_domains\`: email domains allowed to register.
- \`2fa_enabled\`: enables TOTP enforcement when the user has enrolled 2FA.
- \`session.access_token_ttl_minutes\`: optional 15-60 minute access-token override.
- \`org_features\`: enables organisations, teams, groups, access requests, and feature flags for the domain.

## Backend-to-backend auth

Domain-scoped backend endpoints use:

\`\`\`text
Authorization: Bearer SHA256(domain + domain_client_secret)
\`\`\`

The per-domain client secret is created or rotated in the Admin UI under Domains & Secrets. Store it only in the client backend environment. The auth service stores only a server-peppered digest of the derived client hash plus a short display prefix. This applies to token exchange, token revoke, domain APIs, server-driven team invites, and access-request review APIs. Browser code must never use the domain-hash mechanism.

## Admin access

The first-party Admin UI is served from [/admin](/admin). Admin login uses the same auth system with its own first-party config:

- \`/admin/login\` redirects into \`/auth\` with PKCE.
- The admin config is served from \`/internal/admin/config\`.
- The admin config JWT verifies through the public JWKS at \`/.well-known/jwks.json\`.
- The admin config must use the admin domain, disable registration, and allow only Google.
- \`/admin/auth/callback\` exchanges the authorization code at \`POST /internal/admin/token\`.
- Admin access tokens are signed with \`ADMIN_ACCESS_TOKEN_SECRET\`.
- Only \`role: "superuser"\` tokens for \`ADMIN_AUTH_DOMAIN\` can access \`/internal/admin/*\`.
- \`ADMIN_AUTH_DOMAIN\` defaults to the resolved auth service identifier, which is inferred from \`PUBLIC_BASE_URL\` unless \`AUTH_SERVICE_IDENTIFIER\` explicitly overrides it.
- DB-backed deployments also require a \`SUPERUSER\` row in \`domain_roles\` for that admin domain.
- The admin callback must read the exact first-party admin config locally, not by fetching its own public edge URL.

## Debugging config problems

Use \`POST /config/validate\` in every environment. In non-production environments with \`DEBUG_ENABLED=true\`, \`POST /config/verify\` additionally accepts a \`jwks_url\` override for local setup debugging.

## Related operational endpoints

- \`GET /domain/users\`: list users for a domain.
- \`GET /domain/logs\`: domain login logs.
- \`GET /org/me\`: current user's org context.
- \`GET /internal/admin/handshake-errors\`: sanitized app handshake and config JWT errors for superusers, including redacted request/response context when config_url fetches fail before a JWT can be decoded.

Use [/api](/api) for the complete JSON endpoint schema.`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

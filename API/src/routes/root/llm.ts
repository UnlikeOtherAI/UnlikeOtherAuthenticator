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
- Health check: [/health](/health)

## Core auth flow

1. Create a backend endpoint on your application that returns a signed config JWT.
2. The JWT header must use \`alg: "RS256"\` and include a \`kid\` that resolves through the configured JWKS.
3. The JWT audience must match \`AUTH_SERVICE_IDENTIFIER\`.
4. Open the auth UI with:

\`\`\`text
GET /auth?config_url=<your_config_endpoint_url>&redirect_url=<your_callback_url>&code_challenge=<S256_challenge>&code_challenge_method=S256
\`\`\`

5. After the user authenticates, this service redirects to your \`redirect_url\` with \`?code=<authorization_code>\`.
6. Your backend exchanges the code:

\`\`\`text
POST /auth/token?config_url=<your_config_endpoint_url>
Authorization: Bearer SHA256(domain + SHARED_SECRET)
Content-Type: application/json

{
  "code": "<authorization_code>",
  "redirect_url": "<same callback URL used for login>",
  "code_verifier": "<PKCE verifier>"
}
\`\`\`

7. Store refresh tokens server-side only. Browser clients must not receive or persist refresh tokens.
8. Revoke refresh tokens on logout with \`POST /auth/revoke\`.

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
Authorization: Bearer SHA256(domain + SHARED_SECRET)
\`\`\`

This applies to token exchange, token revoke, domain APIs, server-driven team invites, and access-request review APIs. Browser code must never use the domain-hash shared-secret mechanism.

## Admin access

The first-party Admin UI is served from [/admin](/admin). Admin login uses the same auth system with its own first-party config:

- \`/admin/login\` redirects into \`/auth\` with PKCE.
- The admin config is served from \`/internal/admin/config\`.
- The admin config must use the admin domain, disable registration, and allow only Google.
- \`/admin/auth/callback\` exchanges the authorization code at \`POST /internal/admin/token\`.
- Admin access tokens are signed with \`ADMIN_ACCESS_TOKEN_SECRET\`.
- Only \`role: "superuser"\` tokens for \`ADMIN_AUTH_DOMAIN\` can access \`/internal/admin/*\`.
- DB-backed deployments also require a \`SUPERUSER\` row in \`domain_roles\` for that admin domain.

## Debugging config problems

In non-production environments with \`DEBUG_ENABLED=true\`, use \`POST /config/verify\` with \`config\`, \`config_jwt\`, or \`config_url\`. It separates fetch, signature, audience, schema, and domain-match failures.

## Related operational endpoints

- \`GET /domain/users\`: list users for a domain.
- \`GET /domain/logs\`: domain login logs.
- \`GET /org/me\`: current user's org context.
- \`GET /internal/admin/handshake-errors\`: sanitized app handshake and config JWT errors for superusers.

Use [/api](/api) for the complete JSON endpoint schema.`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

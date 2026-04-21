import type { FastifyInstance } from 'fastify';

import { configJwtDocumentation, configVerificationEndpointDocumentation } from './config-docs.js';

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async () => {
    return {
      service: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service. All client configuration is delivered via a signed JWT fetched from a config_url. The JWT must be signed with RS256, include a kid, and verify against the configured JWKS on every request.',

      authentication: {
        overview:
          'Clients integrate via the OAuth 2.0 authorization code flow. The auth UI is rendered by this service at /auth. After authentication, an authorization code is returned to the client redirect_url. The client backend exchanges that code for tokens at POST /auth/token.',
        domain_auth:
          'Backend-to-backend endpoints (POST /auth/token, POST /auth/revoke, /domain/*, server-driven team invite routes under /org/organisations/:orgId/teams/:teamId/invitations*, and access-request review routes under /org/organisations/:orgId/teams/:teamId/access-requests*) require a domain hash bearer token: SHA-256(domain + SHARED_SECRET). This is sent as Authorization: Bearer <hash>.',
        config_url:
          'Most endpoints require a config_url query parameter pointing to an HTTPS URL that returns the signed config JWT. The server fetches and verifies this JWT on every request.',
        access_tokens:
          'Access tokens are JWTs with issuer AUTH_SERVICE_IDENTIFIER and audience uoa:access-token. Client-domain tokens are signed with SHARED_SECRET. Tokens issued for ADMIN_AUTH_DOMAIN are signed with ADMIN_ACCESS_TOKEN_SECRET. Consumers must verify both iss and aud.',
        admin:
          'The first-party Admin UI is served by the API service at /admin in production and authenticates through UOA itself. Browser code exchanges the Admin authorization code at POST /internal/admin/token with config_url, redirect_url, code, and PKCE verifier; this endpoint requires the verified config domain to match ADMIN_AUTH_DOMAIN and returns only a short-lived access token, never a refresh token. Admin access tokens are signed with ADMIN_ACCESS_TOKEN_SECRET, which is auth-service-only and not shared with client backends. Protected endpoints under /internal/admin/* require Authorization: Bearer <access_token> where the token role is superuser and the token domain matches ADMIN_AUTH_DOMAIN, defaulting to AUTH_SERVICE_IDENTIFIER. When DATABASE_URL is configured, the token subject must also have a SUPERUSER domain_roles row for that admin domain. Browser admin code must never use the domain-hash shared-secret mechanism.',
      },

      config_jwt: configJwtDocumentation,
      config_verification: configVerificationEndpointDocumentation,

      environment_variables: {
        required: {
          SHARED_SECRET: 'HMAC secret shared between the auth service and client backends',
          AUTH_SERVICE_IDENTIFIER:
            'Audience claim for config JWTs. Must match the aud in signed config JWTs.',
          ADMIN_ACCESS_TOKEN_SECRET:
            'Auth-service-only HMAC secret used for ADMIN_AUTH_DOMAIN access tokens. Required because /internal/admin/* is always registered.',
          CONFIG_JWKS_URL:
            'Trusted JWKS endpoint used to verify RS256 config JWT signatures by kid.',
        },
        optional: {
          NODE_ENV: '"development" | "test" | "production" (default: "development")',
          HOST: 'Bind address (default: "127.0.0.1")',
          PORT: 'Listen port (default: 3000)',
          PUBLIC_BASE_URL: 'Public origin for email links (e.g. "https://auth.example.com")',
          ADMIN_AUTH_DOMAIN:
            'Domain whose superuser tokens may access /internal/admin/* (default: AUTH_SERVICE_IDENTIFIER)',
          LOG_LEVEL: '"fatal" | "error" | "warn" | "info" | "debug" | "trace" (default: "info")',
          DEBUG_ENABLED:
            'Set true to include internal error code, summary, details, hints, and auth debug HTML in responses. Default false.',
          DATABASE_URL: 'PostgreSQL connection string',
          ACCESS_TOKEN_TTL:
            'JWT access token lifetime, minutes only (default: "30m", range: 15m-60m)',
          REFRESH_TOKEN_TTL_DAYS:
            'Fallback refresh token lifetime in days (default: 30, range: 1-90). Overridden by config session settings.',
          TOKEN_PRUNE_RETENTION_DAYS:
            'Days after refresh-token expiry before expired refresh token rows are pruned (default: 7, max: 365)',
          LOG_RETENTION_DAYS: 'Login log retention in days (default: 90, max: 365)',
          EMAIL_PROVIDER: '"disabled" | "smtp" | "ses" | "sendgrid"',
          EMAIL_FROM: 'Sender email address',
          EMAIL_REPLY_TO: 'Reply-to email address',
          AWS_REGION: 'AWS region for SES',
          SENDGRID_API_KEY: 'SendGrid API key',
          SMTP_HOST: 'SMTP server hostname',
          SMTP_PORT: 'SMTP server port',
          SMTP_SECURE: '"true" | "false" for implicit TLS',
          SMTP_USER: 'SMTP username',
          SMTP_PASSWORD: 'SMTP password',
          GOOGLE_CLIENT_ID: 'Google OAuth client ID',
          GOOGLE_CLIENT_SECRET: 'Google OAuth client secret',
          FACEBOOK_CLIENT_ID: 'Facebook OAuth app ID',
          FACEBOOK_CLIENT_SECRET: 'Facebook OAuth app secret',
          GITHUB_CLIENT_ID: 'GitHub OAuth app ID',
          GITHUB_CLIENT_SECRET: 'GitHub OAuth app secret',
          LINKEDIN_CLIENT_ID: 'LinkedIn OAuth app ID',
          LINKEDIN_CLIENT_SECRET: 'LinkedIn OAuth app secret',
          APPLE_CLIENT_ID: 'Apple Sign In service ID',
          APPLE_TEAM_ID: 'Apple developer team ID',
          APPLE_KEY_ID: 'Apple key ID',
          APPLE_PRIVATE_KEY: 'Apple private key PEM contents',
          AI_TRANSLATION_PROVIDER: '"disabled" | "openai" (default: "disabled")',
          OPENAI_API_KEY: 'OpenAI API key for AI translations',
          OPENAI_MODEL: 'OpenAI model for AI translations',
        },
      },

      integration_guide: {
        step_1:
          'Create an HTTPS config JWT endpoint on your backend that returns a signed JWT with your domain, redirect_urls, enabled_auth_methods, ui_theme, and language_config.',
        step_2:
          'In non-production environments with DEBUG_ENABLED=true, POST /config/verify with either config, config_jwt, or config_url before wiring the auth popup. Use jwks_url and auth_service_identifier when you want the auth service to confirm signature/audience problems separately from schema problems.',
        step_3:
          'Open the auth popup/redirect to: GET /auth?config_url=<your_config_endpoint_url>&redirect_url=<your_callback_url>&code_challenge=<S256_challenge>&code_challenge_method=S256 (redirect_uri is also accepted as an alias for redirect_url)',
        step_4:
          'After authentication, the user is redirected to your redirect_url with ?code=<authorization_code>.',
        step_5:
          'Exchange the code from your backend: POST /auth/token with { "code": "<auth_code>", "redirect_url": "<same_callback_url_used_for_login>", "code_verifier": "<PKCE_verifier>" }, Authorization: Bearer SHA256(domain+SHARED_SECRET), and config_url query param.',
        step_6:
          'Store the refresh_token server-side. Use the access_token for API calls. Refresh via POST /auth/token with { "grant_type": "refresh_token", "refresh_token": "<token>" }.',
        step_7: 'On logout, call POST /auth/revoke with the refresh_token to revoke the session.',
        step_8:
          'To invite a batch of users into a team from your backend, call POST /org/organisations/:orgId/teams/:teamId/invitations with Authorization: Bearer SHA256(domain+SHARED_SECRET), config_url, optional invitedBy metadata, and invites: [{ email, name?, teamRole? }]. If the same team/email is invited again before acceptance, the old active invite is replaced and a fresh email is sent.',
        step_9:
          'Invite emails land on GET /auth/email/team-invite, where the recipient can explicitly accept or decline the invitation. Decline is handled by GET /auth/email/team-invite/decline and recorded on the invite row.',
        step_10:
          'Invite emails include a tracking pixel at GET /auth/email/team-invite-open/:inviteId.gif. Team invite records expose openedAt/openCount so your backend can see whether an invite email was opened at all. This is best-effort because some mail clients proxy or block remote images.',
        step_11:
          'To let a user ask for access to one configured team, send them through the normal auth flow with request_access=true on /auth/login, /auth/register, /auth/verify-email, /auth/email/link, or /auth/social/:provider. The user authenticates first; then the service either auto-grants them to access_requests.target_team_id if their verified email domain matches access_requests.auto_grant_domains, or creates/refreshes a pending access request.',
        step_12:
          'When a pending access request is created, notification emails go to the configured org roles. The email includes access_requests.admin_review_url if provided, otherwise it falls back to https://<domain>/. The user is redirected back to /auth with request_access_status=pending so the popup can render an "access requested" confirmation state instead of issuing an authorization code.',
        step_13:
          'Your backend can list and review access requests with GET /org/organisations/:orgId/teams/:teamId/access-requests plus POST .../:requestId/approve or POST .../:requestId/reject. These endpoints are domain-hash protected and only work for the exact org/team configured in access_requests.',
        step_14:
          'Team records now expose a unique slug per organisation. POST /org/organisations/:orgId/teams accepts an optional slug; if omitted, the service derives one from the team name and appends a number when needed. PUT /org/organisations/:orgId/teams/:teamId also accepts an optional slug, while omitting it leaves the existing slug unchanged. Existing teams are backfilled during the team-slug migration.',
        step_15:
          'If org_features.user_needs_team=true, token issuance self-heals before building the access-token org claim. Users already in a domain org but with zero teams get a personal "<name>\'s team" with teamRole=lead and member->admin promotion when org_roles includes admin. Users with no org on the domain get a new personal org plus a default personal team.',
        step_16:
          '2FA reset emails land on GET /auth/email/twofa-reset, which only renders a no-store confirmation page. The one-time token is consumed only by an explicit POST to /auth/email/twofa-reset/confirm with the same token and config_url query parameters.',
        step_17:
          'Open the Admin UI at /admin on the API origin. Authenticate through UOA itself using a config whose domain is ADMIN_AUTH_DOMAIN, then exchange the authorization code at POST /internal/admin/token with config_url, redirect_url, code, and code_verifier. This browser-safe endpoint does not require domain-hash auth and does not return a refresh token. Call /internal/admin/session with Authorization: Bearer <access_token>. Only access tokens with role=superuser for ADMIN_AUTH_DOMAIN are accepted, and DB-backed deployments also require a SUPERUSER domain_roles row for that subject and domain. Use the same bearer token for /internal/admin/dashboard, domains, organisations, teams, users, logs, handshake-errors, settings, and search.',
      },
    };
  });
}

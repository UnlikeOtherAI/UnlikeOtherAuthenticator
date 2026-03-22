import type { FastifyInstance } from 'fastify';

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async () => {
    return {
      service: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service. All client configuration is delivered via a signed JWT fetched from a config_url. The JWT is signed with a shared HMAC secret (HS256/HS384/HS512) and verified on every request.',

      authentication: {
        overview:
          'Clients integrate via the OAuth 2.0 authorization code flow. The auth UI is rendered by this service at /auth. After authentication, an authorization code is returned to the client redirect_url. The client backend exchanges that code for tokens at POST /auth/token.',
        domain_auth:
          'Backend-to-backend endpoints (POST /auth/token, POST /auth/revoke, /domain/*) require a domain hash bearer token: SHA-256(domain + SHARED_SECRET). This is sent as Authorization: Bearer <hash>.',
        config_url:
          'Most endpoints require a config_url query parameter pointing to a URL that returns the signed config JWT. The server fetches and verifies this JWT on every request.',
      },

      config_jwt: {
        description:
          'The config JWT is a signed JWT containing all client-specific settings. It must be signed with the same SHARED_SECRET used by this auth service. The JWT audience must match the AUTH_SERVICE_IDENTIFIER env var.',
        signing: 'HS256, HS384, or HS512',
        required_fields: {
          domain: 'string — The client domain (must match the config_url hostname)',
          redirect_urls: 'string[] — Allowed OAuth redirect URLs (min 1)',
          enabled_auth_methods:
            'string[] — Auth methods to show: "email_password", "google", "facebook", "github", "linkedin", "apple"',
          ui_theme: {
            description: 'object — Full theme configuration (colors, radii, typography, logo, etc.)',
            logo: {
              url: 'string — Logo image URL (HTTPS/HTTP) or empty string',
              alt: 'string (required) — Alt text for the logo (always required even for text logos)',
              text: 'string (optional, max 100) — Text to display instead of an image when url is empty',
              font_size: 'string (optional) — CSS font size for text logo (e.g. "24px", "2rem")',
              color: 'string (optional) — Hex color for text logo (e.g. "#111827")',
              style: 'Record<string, string> (optional) — Additional CSS properties for text logo (e.g. {"font-weight":"800","letter-spacing":"-0.02em"})',
              note: 'If url is provided it takes precedence over text. If neither is set, no logo is rendered.',
            },
          },
          language_config:
            'string | string[] — Single language code or array of language codes for the auth UI',
        },
        optional_fields: {
          '2fa_enabled': 'boolean (default: false) — Enable TOTP-based two-factor authentication',
          debug_enabled: 'boolean (default: false) — Enable debug endpoint for the domain',
          user_scope:
            '"global" | "per_domain" (default: "global") — "global" means email is the unique user key; "per_domain" means domain|email',
          allow_registration:
            'boolean (default: true) — Whether new user registration is allowed',
          registration_mode:
            '"password_required" | "passwordless" (default: "password_required") — How new users register',
          allowed_registration_domains:
            'string[] — Restrict registration to specific email domains',
          registration_domain_mapping:
            'array of { email_domain, org_id, team_id? } — Auto-place new users into orgs/teams based on their email domain',
          allowed_social_providers: 'string[] — Subset of social providers to show',
          language: 'string — Currently selected language override',
          session: {
            description: 'Session and token lifetime configuration',
            fields: {
              remember_me_enabled:
                'boolean (default: true) — Show the "Remember me" checkbox on login',
              remember_me_default:
                'boolean (default: true) — Default checked state of the checkbox',
              short_refresh_token_ttl_hours:
                'number (default: 1, range: 1-168) — Refresh token TTL in hours when remember-me is OFF',
              long_refresh_token_ttl_days:
                'number (default: 30, range: 1-90) — Refresh token TTL in days when remember-me is ON',
              access_token_ttl_minutes:
                'number (range: 15-60) — Override access token JWT TTL. Falls back to ACCESS_TOKEN_TTL env var if not set',
            },
          },
          org_features: {
            description: 'Organisation, team, and group management features',
            fields: {
              enabled: 'boolean (default: false) — Enable org features',
              groups_enabled: 'boolean (default: false) — Enable groups within orgs',
              max_teams_per_org: 'number (default: 100, max: 1000)',
              max_groups_per_org: 'number (default: 20, max: 200)',
              max_members_per_org: 'number (default: 1000, max: 10000)',
              max_members_per_team: 'number (default: 200, max: 5000)',
              max_members_per_group: 'number (default: 500, max: 5000)',
              max_team_memberships_per_user: 'number (default: 50, max: 200)',
              org_roles:
                'string[] (default: ["owner", "admin", "member"]) — Must include "owner"',
            },
          },
        },
      },

      environment_variables: {
        required: {
          SHARED_SECRET: 'HMAC secret shared between the auth service and client backends',
          AUTH_SERVICE_IDENTIFIER:
            'Audience claim for config JWTs. Must match the aud in signed config JWTs.',
        },
        optional: {
          NODE_ENV: '"development" | "test" | "production" (default: "development")',
          HOST: 'Bind address (default: "127.0.0.1")',
          PORT: 'Listen port (default: 3000)',
          PUBLIC_BASE_URL: 'Public origin for email links (e.g. "https://auth.example.com")',
          LOG_LEVEL: '"fatal" | "error" | "warn" | "info" | "debug" | "trace" (default: "info")',
          DATABASE_URL: 'PostgreSQL connection string',
          ACCESS_TOKEN_TTL:
            'JWT access token lifetime, minutes only (default: "30m", range: 15m-60m)',
          REFRESH_TOKEN_TTL_DAYS:
            'Fallback refresh token lifetime in days (default: 30, range: 1-90). Overridden by config session settings.',
          LOG_RETENTION_DAYS: 'Login log retention (default: 90)',
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
          'Create a config JWT endpoint on your backend that returns a signed JWT with your domain, redirect_urls, enabled_auth_methods, and ui_theme.',
        step_2:
          'Open the auth popup/redirect to: GET /auth?config_url=<your_config_endpoint_url>&redirect_url=<your_callback_url>',
        step_3:
          'After authentication, the user is redirected to your redirect_url with ?code=<authorization_code>.',
        step_4:
          'Exchange the code from your backend: POST /auth/token with { "code": "<auth_code>" }, Authorization: Bearer SHA256(domain+SHARED_SECRET), and config_url query param.',
        step_5:
          'Store the refresh_token server-side. Use the access_token for API calls. Refresh via POST /auth/token with { "grant_type": "refresh_token", "refresh_token": "<token>" }.',
        step_6: 'On logout, call POST /auth/revoke with the refresh_token to revoke the session.',
      },
    };
  });
}

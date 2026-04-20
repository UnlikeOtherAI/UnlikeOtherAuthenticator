export const configExample = {
  domain: 'client.example.com',
  redirect_urls: ['https://client.example.com/oauth/callback'],
  enabled_auth_methods: ['email_password', 'google'],
  ui_theme: {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: {
      card: '16px',
      button: '12px',
      input: '12px',
    },
    density: 'comfortable',
    typography: {
      font_family: 'sans',
      base_text_size: 'md',
    },
    button: {
      style: 'solid',
    },
    card: {
      style: 'bordered',
    },
    logo: {
      url: '',
      alt: 'Client logo',
      text: 'Client',
      font_size: '24px',
      color: '#0f172a',
      style: {
        fontWeight: '800',
        letterSpacing: '0.02em',
      },
    },
  },
  language_config: 'en',
  debug_enabled: true,
  allow_registration: true,
  registration_mode: 'password_required',
  user_scope: 'global',
};

export const configJwtDocumentation = {
  description:
    'The config JWT is a signed JWT containing all client-specific settings. The payload is the config. The signature must be RS256, the protected header must include kid, and the JWT aud must match AUTH_SERVICE_IDENTIFIER.',
  signing: {
    algorithms: ['RS256'],
    key_selection:
      'The JWT protected header must include kid. The auth service resolves that kid from CONFIG_JWKS_URL and rejects tokens without kid.',
    audience:
      'The JWT aud claim must match the auth service identifier configured in AUTH_SERVICE_IDENTIFIER.',
  },
  required_fields: {
    domain:
      'string — client domain. This must exactly match the hostname of the HTTPS config_url when the auth service fetches the JWT.',
    redirect_urls:
      'string[] — non-empty list of absolute HTTP/HTTPS callback URLs. redirect_url matching is exact.',
    enabled_auth_methods:
      'string[] — non-empty list. Supported values are email_password, google, facebook, github, linkedin, apple.',
    language_config:
      'string | string[] — either one language code or a non-empty array of language codes.',
    ui_theme: {
      description:
        'object — every auth page style comes from ui_theme. This object is required and the main source of integration mistakes.',
      required_sections: {
        colors: {
          required_keys: [
            'bg',
            'surface',
            'text',
            'muted',
            'primary',
            'primary_text',
            'border',
            'danger',
            'danger_text',
          ],
          value_format: 'hex color only (#RGB, #RGBA, #RRGGBB, #RRGGBBAA) or transparent',
        },
        radii: {
          required_keys: ['card', 'button', 'input'],
          value_format: 'CSS length string: px, rem, em, %, or 0',
        },
        density: 'compact | comfortable | spacious',
        typography: {
          required_keys: ['font_family', 'base_text_size'],
          font_family:
            'Preset values like sans, serif, mono are valid. Custom font names must match /^[A-Za-z0-9 _-]+$/.',
          base_text_size: 'sm | md | lg',
          font_import_url:
            'optional HTTPS stylesheet URL. The Auth UI silently drops font imports outside fonts.googleapis.com, fonts.gstatic.com, and fonts.bunny.net.',
        },
        button: {
          required_keys: ['style'],
          style: 'solid | outline | ghost',
        },
        card: {
          required_keys: ['style'],
          style: 'plain | bordered | shadow',
        },
        logo: {
          required_keys: ['url', 'alt'],
          url: 'HTTPS URL on the same host as config.domain, or empty string',
          alt: 'required non-empty string',
          text: 'optional text logo, max 100 chars, used when url is empty',
          font_size: 'optional CSS length string',
          color: 'optional hex color',
          style:
            'optional flat object. The Auth UI applies only color, fontSize, fontWeight, and letterSpacing.',
        },
      },
      optional_sections: {
        css_vars: 'Record<string, string> — optional advanced CSS variable overrides.',
      },
      common_failures: [
        'Missing one of the required ui_theme sections such as colors, radii, button, card, typography, or logo.',
        'Using non-hex colors like rgb(...), hsl(...), or named colors.',
        'Using bare numbers for radii/font sizes instead of CSS length strings like 12px or 1rem.',
        'Providing a text logo without logo.alt.',
        'Forgetting button.style or card.style.',
      ],
      example: configExample.ui_theme,
    },
  },
  optional_fields: {
    '2fa_enabled': 'boolean (default false)',
    debug_enabled: 'boolean (default false)',
    allowed_social_providers: 'string[] — subset of enabled social providers',
    user_scope: '"global" | "per_domain" (default "global")',
    allow_registration: 'boolean (default true)',
    registration_mode: '"password_required" | "passwordless" (default "password_required")',
    allowed_registration_domains: 'string[] — lowercase email domains allowed to register',
    registration_domain_mapping:
      'array of { email_domain, org_id, team_id? } — email-domain-based org/team placement',
    language: 'string — currently selected language override',
    session: {
      remember_me_enabled: 'boolean (default true)',
      remember_me_default: 'boolean (default true)',
      short_refresh_token_ttl_hours: 'number (1-168, default 1)',
      long_refresh_token_ttl_days: 'number (1-90, default 30)',
      access_token_ttl_minutes: 'number (15-60)',
    },
    org_features: {
      enabled: 'boolean (default false)',
      groups_enabled: 'boolean (default false)',
      user_needs_team: 'boolean (default false)',
      max_teams_per_org: 'number (default 100, max 1000)',
      max_groups_per_org: 'number (default 20, max 200)',
      max_members_per_org: 'number (default 1000, max 10000)',
      max_members_per_team: 'number (default 200, max 5000)',
      max_members_per_group: 'number (default 500, max 5000)',
      max_team_memberships_per_user: 'number (default 50, max 200)',
      org_roles: 'string[] (default ["owner", "admin", "member"]). Must include "owner".',
    },
    access_requests: {
      enabled: 'boolean (default false)',
      target_org_id: 'string (required when enabled=true)',
      target_team_id: 'string (required when enabled=true)',
      auto_grant_domains: 'string[]',
      notify_org_roles: 'string[] (default ["owner", "admin"])',
      admin_review_url: 'absolute URL',
    },
  },
  example_payload: configExample,
};

export const configVerificationEndpointDocumentation = {
  path: '/config/verify',
  method: 'POST',
  description:
    'Non-production DEBUG_ENABLED-only debug endpoint that validates raw config JSON, a signed config JWT, or a config_url fetch target. It reports schema problems separately from signature, audience, and config_url/domain issues.',
  auth: 'Available only when DEBUG_ENABLED=true and NODE_ENV is not production; IP rate limited.',
  body: {
    config:
      'object (optional) — raw config payload to schema-validate directly. This skips JWT signature checking unless config_jwt or config_url is also supplied instead.',
    config_jwt:
      'string (optional) — signed config JWT to decode, inspect, schema-validate, and verify with a JWKS.',
    config_url:
      'string (optional) — URL that should return the signed config JWT. The endpoint fetches it and then runs the same checks.',
    jwks_url:
      'string (optional) — JWKS URL used to verify config_jwt or the JWT fetched from config_url. Defaults to CONFIG_JWKS_URL.',
    auth_service_identifier:
      'string (optional) — expected JWT aud. Defaults to this auth service environment when omitted.',
  },
  source_priority: ['config', 'config_jwt', 'config_url'],
  response: {
    ok: 'boolean — true when every executed check passed',
    schema_valid: 'boolean',
    jwt_signature_valid: 'boolean | null — null when signature checking was skipped',
    audience_valid: 'boolean | null — null when no audience check was possible',
    domain_match:
      'boolean | null — null when config_url was not part of the request or schema parsing failed',
    checks:
      'object — per-stage results for source, fetch, decode, signature, audience, schema, and domain_match',
    issues: 'array — structured stage-specific failures and warnings',
    config_summary:
      'object | null — safe summary of the parsed config when schema validation succeeds',
  },
};

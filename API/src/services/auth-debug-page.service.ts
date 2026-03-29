import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import type { AppError } from '../utils/errors.js';

export type AuthDebugStage =
  | 'request'
  | 'config_url'
  | 'config_fetch'
  | 'config_verify'
  | 'config_schema'
  | 'config_domain'
  | 'internal';

export type AuthDebugInfo = {
  stage: AuthDebugStage;
  code: string;
  summary: string;
  configUrl: string | null;
  redirectUrl: string | null;
  requestPath: string;
  details: string[];
  hints: string[];
};

declare module 'fastify' {
  interface FastifyRequest {
    authDebug?: AuthDebugInfo;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrlForDebug(
  raw: string | null | undefined,
  options?: { includeQueryKeys?: boolean },
): string | null {
  if (!raw?.trim()) return null;

  try {
    const url = new URL(raw);
    const base = `${url.origin}${url.pathname}`;
    if (!options?.includeQueryKeys || url.searchParams.size === 0) return base;

    const queryKeys = [...new Set(url.searchParams.keys())];
    if (!queryKeys.length) return base;
    return `${base}?${queryKeys.map((key) => `${key}=…`).join('&')}`;
  } catch {
    return raw.trim();
  }
}

function tryParseUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function parseRequestDebugUrls(requestUrl: string | undefined): {
  configUrl: string | null;
  redirectUrl: string | null;
  requestPath: string;
} {
  const fallback = {
    configUrl: null,
    redirectUrl: null,
    requestPath: '/auth',
  };
  if (!requestUrl) return fallback;

  try {
    const url = new URL(requestUrl, 'http://local-auth-request');
    return {
      configUrl: sanitizeUrlForDebug(url.searchParams.get('config_url')),
      redirectUrl: sanitizeUrlForDebug(
        url.searchParams.get('redirect_url') ?? url.searchParams.get('redirect_uri'),
        { includeQueryKeys: true },
      ),
      requestPath: url.pathname || fallback.requestPath,
    };
  } catch {
    return fallback;
  }
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function deriveSchemaHints(details: string[]): string[] {
  const hints: string[] = [];

  if (details.some((detail) => detail.startsWith('ui_theme'))) {
    hints.push(
      'Supply the full ui_theme object. Required sections are colors, radii, density, button, card, typography, and logo.',
    );
  }
  if (details.some((detail) => detail.startsWith('ui_theme.colors'))) {
    hints.push(
      'Add ui_theme.colors.bg, surface, text, muted, primary, primary_text, border, danger, and danger_text.',
    );
  }
  if (details.some((detail) => detail.startsWith('ui_theme.radii'))) {
    hints.push('Add ui_theme.radii.card, button, and input CSS length values.');
  }
  if (details.some((detail) => detail.startsWith('ui_theme.density'))) {
    hints.push('Set ui_theme.density to one of compact, comfortable, or spacious.');
  }
  if (details.some((detail) => detail.startsWith('ui_theme.button'))) {
    hints.push('Set ui_theme.button.style to one of solid, outline, or ghost.');
  }
  if (details.some((detail) => detail.startsWith('ui_theme.card'))) {
    hints.push('Set ui_theme.card.style to one of plain, bordered, or shadow.');
  }
  if (details.some((detail) => detail.startsWith('redirect_urls'))) {
    hints.push('Ensure redirect_urls contains at least one valid absolute URL allowed for this client.');
  }
  if (details.some((detail) => detail.startsWith('enabled_auth_methods'))) {
    hints.push('Ensure enabled_auth_methods contains at least one supported login method.');
  }
  if (details.some((detail) => detail.startsWith('language_config'))) {
    hints.push('Set language_config to a language string or a non-empty array of languages.');
  }

  return hints;
}

function deriveStageHints(stage: AuthDebugStage, code: string): string[] {
  switch (code) {
    case 'CONFIG_URL_REJECTED':
      return ['The config_url must not embed the shared secret or any raw secret value.'];
    case 'CONFIG_FETCH_FAILED':
      return [
        'The auth service could not fetch a config JWT from config_url. Check the URL, network reachability, and that the endpoint returns HTTP 200.',
        'The config endpoint should return plain text JWT or JSON containing jwt/token/config_jwt.',
      ];
    case 'CONFIG_JWT_INVALID':
      return [
        'The fetched config JWT could not be verified for this auth service. Check the shared secret and the aud claim.',
      ];
    case 'CONFIG_PAYLOAD_SECRET_REJECTED':
      return ['The config JWT payload must not contain the shared secret or any embedded secret value.'];
    case 'CONFIG_DOMAIN_MISMATCH':
      return ['The config JWT domain claim must exactly match the hostname of config_url.'];
    case 'CONFIG_SCHEMA_INVALID':
      return [];
    default:
      if (stage === 'request') {
        return ['Check that config_url is present and points to the client backend endpoint that returns the signed config JWT.'];
      }
      return ['Check the auth request query parameters and the client config being returned by config_url.'];
  }
}

function buildConfigExample(debug: AuthDebugInfo): string | null {
  if (debug.code !== 'CONFIG_SCHEMA_INVALID') return null;

  const configUrl = tryParseUrl(debug.configUrl);
  const redirectUrl = tryParseUrl(debug.redirectUrl);
  const domain = configUrl?.hostname ?? 'client.example.com';
  const redirect = redirectUrl?.toString() ?? `https://${domain}/auth/callback`;
  const logoUrl = configUrl ? `${configUrl.origin}/logo.svg` : `https://${domain}/logo.svg`;

  const example = {
    domain,
    redirect_urls: [redirect],
    enabled_auth_methods: ['email_password', 'google'],
    allowed_social_providers: ['google'],
    ui_theme: {
      colors: {
        bg: '#0f172a',
        surface: '#111827',
        text: '#e5e7eb',
        muted: '#94a3b8',
        primary: '#2563eb',
        primary_text: '#ffffff',
        border: '#334155',
        danger: '#dc2626',
        danger_text: '#ffffff',
      },
      radii: {
        card: '20px',
        button: '12px',
        input: '12px',
      },
      density: 'comfortable',
      typography: {
        font_family: 'Inter, system-ui, sans-serif',
        base_text_size: 'md',
        font_import_url: '',
      },
      button: {
        style: 'solid',
      },
      card: {
        style: 'shadow',
      },
      logo: {
        url: logoUrl,
        alt: 'Client logo',
        text: 'Client',
      },
    },
    language_config: 'en',
    user_scope: 'global',
    '2fa_enabled': false,
    debug_enabled: false,
    allow_registration: true,
    registration_mode: 'password_required',
    session: {
      remember_me_enabled: true,
      remember_me_default: true,
      short_refresh_token_ttl_hours: 1,
      long_refresh_token_ttl_days: 30,
      access_token_ttl_minutes: 30,
    },
    org_features: {
      enabled: true,
      groups_enabled: false,
      user_needs_team: false,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
    },
    access_requests: {
      enabled: false,
      notify_org_roles: ['owner', 'admin'],
    },
  };

  return JSON.stringify(example, null, 2);
}

export function createAuthDebugInfo(params: {
  requestUrl?: string;
  stage?: AuthDebugStage;
  code?: string;
  summary?: string;
  details?: string[];
  hints?: string[];
}): AuthDebugInfo {
  const parsed = parseRequestDebugUrls(params.requestUrl);
  const stage = params.stage ?? 'request';
  const code = params.code ?? 'AUTH_REQUEST_FAILED';
  const details = params.details ?? [];
  const stageHints = params.hints ?? deriveStageHints(stage, code);
  const schemaHints = code === 'CONFIG_SCHEMA_INVALID' ? deriveSchemaHints(details) : [];

  return {
    stage,
    code,
    summary: params.summary ?? 'The auth service could not complete this request.',
    configUrl: parsed.configUrl,
    redirectUrl: parsed.redirectUrl,
    requestPath: parsed.requestPath,
    details,
    hints: [...new Set([...stageHints, ...schemaHints])],
  };
}

export function mergeAuthDebugInfo(
  request: FastifyRequest,
  next: Partial<Omit<AuthDebugInfo, 'configUrl' | 'redirectUrl' | 'requestPath'>>,
): void {
  const current = request.authDebug ?? createAuthDebugInfo({ requestUrl: request.raw.url });
  request.authDebug = createAuthDebugInfo({
    requestUrl: request.raw.url,
    stage: next.stage ?? current.stage,
    code: next.code ?? current.code,
    summary: next.summary ?? current.summary,
    details: next.details ?? current.details,
    hints: next.hints,
  });
}

function parseRedirectQueryKeys(requestUrl: string | undefined): string[] {
  if (!requestUrl) return [];

  try {
    const url = new URL(requestUrl, 'http://local-auth-request');
    const redirectUrl = url.searchParams.get('redirect_url') ?? url.searchParams.get('redirect_uri');
    if (!redirectUrl) return [];
    return [...new Set(new URL(redirectUrl).searchParams.keys())];
  } catch {
    return [];
  }
}

function sanitizeAllowedRedirectUrls(redirectUrls: string[] | undefined): string[] {
  if (!redirectUrls?.length) return [];
  return redirectUrls
    .map((value) => sanitizeUrlForDebug(value, { includeQueryKeys: true }))
    .filter((value): value is string => Boolean(value));
}

export function enrichAuthDebugForAppError(
  request: FastifyRequest & { config?: { redirect_urls?: string[] } },
  error: AppError,
): void {
  const code = error.message || error.code;
  const allowedRedirectUrls = sanitizeAllowedRedirectUrls(request.config?.redirect_urls);
  const redirectQueryKeys = parseRedirectQueryKeys(request.raw.url);
  const configValidatedDetail =
    'config_url was fetched successfully and the config JWT passed signature, schema, and domain checks.';

  if (code === 'REDIRECT_URL_NOT_ALLOWED') {
    const details = [
      configValidatedDetail,
      'The requested redirect_url does not exactly match any value in config.redirect_urls.',
    ];
    if (redirectQueryKeys.length) {
      details.push(`Requested redirect_url includes query keys: ${redirectQueryKeys.join(', ')}.`);
    }
    if (allowedRedirectUrls.length) {
      details.push(`Allowlisted redirect_urls: ${allowedRedirectUrls.join(', ')}.`);
    }

    mergeAuthDebugInfo(request, {
      stage: 'request',
      code,
      summary: 'The requested redirect_url is not allowed for this client config.',
      details,
      hints: [
        'redirect_url matching is exact. Path, trailing slash, and query string must match a value in config.redirect_urls exactly.',
        'Either send the exact allowlisted callback URL or add the exact callback URL your client uses to config.redirect_urls.',
      ],
    });
    return;
  }

  if (code === 'MISSING_REDIRECT_URL') {
    mergeAuthDebugInfo(request, {
      stage: 'request',
      code,
      summary: 'No usable redirect_url was provided and the client config did not supply a fallback.',
      details: allowedRedirectUrls.length
        ? [configValidatedDetail, `Allowlisted redirect_urls: ${allowedRedirectUrls.join(', ')}.`]
        : [configValidatedDetail, 'config.redirect_urls is empty or missing.'],
      hints: [
        'Provide redirect_url in the request, or include at least one valid absolute URL in config.redirect_urls.',
      ],
    });
    return;
  }

  if (code === 'INVALID_REDIRECT_URL') {
    mergeAuthDebugInfo(request, {
      stage: 'request',
      code,
      summary: 'The supplied redirect_url is not a valid absolute HTTP(S) URL.',
      details: allowedRedirectUrls.length
        ? [configValidatedDetail, `Allowlisted redirect_urls: ${allowedRedirectUrls.join(', ')}.`]
        : [configValidatedDetail],
      hints: [
        'Use a full http:// or https:// callback URL and make sure it exactly matches a value in config.redirect_urls.',
      ],
    });
  }
}

export function renderAuthDebugHtml(params: {
  statusCode: number;
  requestUrl?: string;
  error?: unknown;
  debug?: AuthDebugInfo;
}): string {
  const fallback =
    params.error instanceof ZodError
      ? createAuthDebugInfo({
          requestUrl: params.requestUrl,
          stage: 'request',
          code: 'AUTH_REQUEST_INVALID',
          summary: 'The auth request query could not be parsed.',
          details: formatZodIssues(params.error),
        })
      : createAuthDebugInfo({ requestUrl: params.requestUrl, stage: 'internal', code: 'AUTH_REQUEST_FAILED' });

  const debug = params.debug ?? fallback;
  const rows = [
    ['Status', String(params.statusCode)],
    ['Stage', debug.stage],
    ['Code', debug.code],
    ['Request path', debug.requestPath],
    ['Config URL', debug.configUrl ?? 'missing'],
    ['Redirect URL', debug.redirectUrl ?? 'not provided'],
  ];

  const detailsHtml = debug.details.length
    ? `<ul>${debug.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('')}</ul>`
    : '<p>No additional structured details were captured.</p>';
  const hintsHtml = debug.hints.length
    ? `<ul>${debug.hints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join('')}</ul>`
    : '<p>No specific fix hints were generated for this failure.</p>';
  const configExample = buildConfigExample(debug);
  const configExampleHtml = configExample
    ? [
        '<section>',
        '<details>',
        '<summary>Full config example</summary>',
        '<p>Use this as a valid starting point, then replace the placeholder values for your client.</p>',
        `<pre>${escapeHtml(configExample)}</pre>`,
        '</details>',
        '</section>',
      ].join('')
    : '';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<title>Auth configuration error</title>',
    '<style>',
    'body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;}',
    'main{max-width:880px;margin:0 auto;padding:40px 20px 64px;}',
    '.card{background:#111827;border:1px solid #334155;border-radius:18px;padding:24px;box-shadow:0 20px 45px rgba(15,23,42,.35);}',
    'h1{margin:0 0 12px;font-size:30px;line-height:1.1;}',
    'p{color:#cbd5e1;line-height:1.6;}',
    '.chips{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 24px;}',
    '.chip{display:inline-block;padding:6px 10px;border-radius:999px;background:#1e293b;color:#f8fafc;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}',
    'section{margin-top:24px;padding-top:20px;border-top:1px solid #334155;}',
    'h2{margin:0 0 12px;font-size:16px;}',
    'dl{display:grid;grid-template-columns:minmax(160px,220px) 1fr;gap:10px 14px;margin:0;}',
    'dt{color:#94a3b8;font-weight:600;}',
    'dd{margin:0;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;}',
    'ul{margin:0;padding-left:20px;}',
    'li{margin:8px 0;line-height:1.5;}',
    'details{border:1px solid #334155;border-radius:14px;background:#0b1220;padding:14px 16px;}',
    'summary{cursor:pointer;font-weight:700;color:#f8fafc;}',
    'details p{margin:14px 0 12px;}',
    'pre{margin:0;overflow:auto;padding:16px;border-radius:14px;background:#020617;border:1px solid #334155;color:#cbd5e1;font-size:12px;line-height:1.6;}',
    '.note{margin-top:18px;color:#94a3b8;font-size:13px;}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<div class="card">',
    '<h1>Auth configuration error</h1>',
    '<p>The auth service could not render this sign-in request. The details below are sanitized so they can be shared with the client team without exposing secrets.</p>',
    '<div class="chips">',
    `<span class="chip">${escapeHtml(String(params.statusCode))}</span>`,
    `<span class="chip">${escapeHtml(debug.code)}</span>`,
    `<span class="chip">${escapeHtml(debug.stage)}</span>`,
    '</div>',
    '<section>',
    '<h2>Summary</h2>',
    `<p>${escapeHtml(debug.summary)}</p>`,
    '</section>',
    '<section>',
    '<h2>Request context</h2>',
    '<dl>',
    ...rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`),
    '</dl>',
    '</section>',
    '<section>',
    '<h2>Diagnostic details</h2>',
    detailsHtml,
    '</section>',
    '<section>',
    '<h2>How to fix it</h2>',
    hintsHtml,
    '</section>',
    configExampleHtml,
    '<p class="note">Secrets, bearer tokens, and raw config JWT contents are intentionally not shown on this page.</p>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

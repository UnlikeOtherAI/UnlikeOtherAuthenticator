import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { z } from 'zod';

import { getEnv, requireEnv } from '../config/env.js';
import {
  createAuthDebugInfo,
  formatZodIssues,
  mergeAuthDebugInfo,
} from '../services/auth-debug-page.service.js';
import { AppError } from '../utils/errors.js';
import {
  assertConfigDomainMatchesConfigUrl,
  validateConfigFields,
  verifyConfigJwtSignature,
  type ClientConfig,
} from '../services/config.service.js';
import { containsSecretValue } from '../services/config-secret-scan.service.js';
import { getConfigFetchDiagnostics } from '../services/config-fetch-diagnostics.service.js';
import { readConfigJwtFromTrustedSource } from '../services/config-jwt-source.service.js';
import { recordHandshakeErrorLog, type HandshakeErrorPhase } from '../services/handshake-error-log.service.js';
import {
  buildHandshakeRequestJson,
  configFetchFailureDetails,
} from '../services/handshake-log-context.service.js';
import {
  readOptInFields,
  tryAutoOnboard,
  type AutoOnboardingOutcome,
} from '../services/auto-onboarding.service.js';

const QuerySchema = z.object({
  config_url: z.string().min(1),
});

const safeJwtHeaderKeys = new Set(['alg', 'typ', 'kid']);
const safeConfigJwtPayloadKeys = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'domain',
  'redirect_urls',
  'registration_redirect_urls',
  'enabled_auth_methods',
  'ui_theme',
  'language_config',
  '2fa_enabled',
  'debug_enabled',
  'user_scope',
  'allow_registration',
  'registration_mode',
  'allowed_registration_domains',
  'registration_domain_mapping',
  'access_requests',
  'language',
  'session',
  'org_features',
]);
const emptyAllowedKeys = new Set<string>();
const safeConfigJwtNestedKeys = new Map<string, ReadonlySet<string>>([
  [
    'payload.ui_theme',
    new Set(['colors', 'radii', 'density', 'typography', 'button', 'card', 'logo', 'css_vars']),
  ],
  [
    'payload.ui_theme.colors',
    new Set(['bg', 'surface', 'text', 'muted', 'primary', 'primary_text', 'border', 'danger', 'danger_text']),
  ],
  ['payload.ui_theme.radii', new Set(['card', 'button', 'input'])],
  ['payload.ui_theme.typography', new Set(['font_family', 'base_text_size', 'font_import_url'])],
  ['payload.ui_theme.button', new Set(['style'])],
  ['payload.ui_theme.card', new Set(['style'])],
  ['payload.ui_theme.logo', new Set(['url', 'alt', 'text', 'font_size', 'color', 'style'])],
  ['payload.registration_domain_mapping', new Set(['email_domain', 'org_id', 'team_id'])],
  [
    'payload.access_requests',
    new Set([
      'enabled',
      'target_org_id',
      'target_team_id',
      'auto_grant_domains',
      'notify_org_roles',
      'admin_review_url',
    ]),
  ],
  [
    'payload.session',
    new Set([
      'remember_me_enabled',
      'remember_me_default',
      'short_refresh_token_ttl_hours',
      'long_refresh_token_ttl_days',
      'access_token_ttl_minutes',
    ]),
  ],
  [
    'payload.org_features',
    new Set([
      'enabled',
      'groups_enabled',
      'user_needs_team',
      'max_teams_per_org',
      'max_groups_per_org',
      'max_members_per_org',
      'max_members_per_team',
      'max_members_per_group',
      'max_team_memberships_per_user',
      'org_roles',
    ]),
  ],
]);

declare module 'fastify' {
  interface FastifyRequest {
    configUrl?: string;
    configJwt?: string;
    config?: ClientConfig;
    integrationOutcome?: AutoOnboardingOutcome;
  }
}

export async function configVerifier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;
  const { config_url } = QuerySchema.parse(request.query);
  request.configUrl = config_url;
  request.authDebug = createAuthDebugInfo({ requestUrl: request.raw.url });

  // Shared secret must never be exposed publicly. Defensively reject requests that
  // try to embed it in the config URL (even though clients should never do this).
  const { SHARED_SECRET, CONFIG_JWKS_URL } = requireEnv(
    'SHARED_SECRET',
    'CONFIG_JWKS_URL',
  );
  if (
    config_url.includes(SHARED_SECRET) ||
    config_url.includes(encodeURIComponent(SHARED_SECRET))
  ) {
    await sleep(randomInt(0, 26));
    mergeAuthDebugInfo(request, {
      stage: 'config_url',
      code: 'CONFIG_URL_REJECTED',
      summary: 'The supplied config_url was rejected before any network request was made.',
    });
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_URL_REJECTED');
  }

  // Task 2.2: fetch the signed config JWT from the client-provided URL.
  try {
    request.configJwt = await readConfigJwtFromTrustedSource(config_url);
  } catch (err) {
    const diagnostics = getConfigFetchDiagnostics(err);
    mergeAuthDebugInfo(request, {
      stage: 'config_fetch',
      code: 'CONFIG_FETCH_FAILED',
      summary: 'The auth service could not fetch a usable config JWT from config_url.',
    });
    void recordConfigVerifierError(request, {
      configUrl: config_url,
      phase: 'config_fetch',
      statusCode: 400,
      errorCode: 'CONFIG_FETCH_FAILED',
      summary: 'The auth service could not fetch a usable config JWT from config_url.',
      details: configFetchFailureDetails(config_url, diagnostics),
      requestJson: diagnostics?.request,
      responseJson: diagnostics?.response,
      extraRedactions: diagnostics?.redactions,
    });
    throw err;
  }

  // Verify the config JWT signature using the configured JWKS.
  let payload;
  try {
    payload = await verifyConfigJwtSignature(
      request.configJwt,
      CONFIG_JWKS_URL,
    );
  } catch (err) {
    // If the partner opted into auto-onboarding, attempt to self-register the request
    // against the JWKS they publish. Trust is still gated on superuser approval — even
    // when auto-onboarding succeeds we end the /auth flow with a friendly pending page.
    if (getEnv().DATABASE_URL && readOptInFields(request.configJwt)) {
      const outcome = await tryAutoOnboard(request.configJwt, config_url);
      request.integrationOutcome = outcome;
      const code =
        outcome.kind === 'declined' ? 'INTEGRATION_DECLINED' : 'INTEGRATION_PENDING_REVIEW';
      const summary =
        outcome.kind === 'declined'
          ? 'This integration was previously declined. Contact support.'
          : 'This integration is pending review. A superuser has been notified.';
      mergeAuthDebugInfo(request, { stage: 'config_verify', code, summary });
      throw new AppError('BAD_REQUEST', 400, code);
    }

    mergeAuthDebugInfo(request, {
      stage: 'config_verify',
      code: 'CONFIG_JWT_INVALID',
      summary: 'The fetched config JWT could not be verified for this auth service.',
    });
    void recordConfigVerifierError(request, {
      configJwt: request.configJwt,
      configUrl: config_url,
      phase: 'jwt_verify',
      statusCode: 401,
      errorCode: 'CONFIG_JWT_INVALID',
      summary: 'The fetched config JWT could not be verified for this auth service.',
      details: ['JWT signature, algorithm, or key lookup failed.'],
    });
    throw err;
  }

  // Shared secret must never be exposed in the config payload that is later rendered
  // into HTML and hydrated by the Auth UI. Reject any config that contains the secret.
  if (containsSecretValue(payload, SHARED_SECRET)) {
    mergeAuthDebugInfo(request, {
      stage: 'config_verify',
      code: 'CONFIG_PAYLOAD_SECRET_REJECTED',
      summary: 'The fetched config payload contained a forbidden secret value.',
    });
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_PAYLOAD_SECRET_REJECTED');
  }

  // Task 2.4 + 2.5: validate required config fields + parse optional config fields.
  try {
    request.config = validateConfigFields(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      mergeAuthDebugInfo(request, {
        stage: 'config_schema',
        code: 'CONFIG_SCHEMA_INVALID',
        summary: 'The config JWT passed fetch and signature checks but failed schema validation.',
        details: formatZodIssues(err),
      });
      void recordConfigVerifierError(request, {
        configJwt: request.configJwt,
        configUrl: config_url,
        phase: 'startup',
        statusCode: 400,
        errorCode: 'CONFIG_SCHEMA_INVALID',
        summary: 'The config JWT passed fetch and signature checks but failed schema validation.',
        details: formatZodIssues(err),
        missingClaims: err.issues.map((issue) => issue.path.join('.')).filter(Boolean),
      });
      throw new AppError('BAD_REQUEST', 400, 'CONFIG_SCHEMA_INVALID');
    }
    throw err;
  }

  // Task 2.8: validate domain claim matches the origin (host) of the config URL.
  try {
    assertConfigDomainMatchesConfigUrl(request.config.domain, config_url);
  } catch (err) {
    mergeAuthDebugInfo(request, {
      stage: 'config_domain',
      code: 'CONFIG_DOMAIN_MISMATCH',
      summary: 'The config JWT domain does not match the hostname of config_url.',
    });
    void recordConfigVerifierError(request, {
      configJwt: request.configJwt,
      configUrl: config_url,
      phase: 'config_domain',
      statusCode: 422,
      errorCode: 'CONFIG_DOMAIN_MISMATCH',
      summary: 'The config JWT domain does not match the hostname of config_url.',
      details: ['The config domain claim did not match the config_url hostname.'],
    });
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requestHost(configUrl: string): string {
  try {
    return normalizeDomain(new URL(configUrl).hostname);
  } catch {
    return 'unknown';
  }
}

function endpointPath(request: FastifyRequest): string {
  try {
    return new URL(request.url, 'http://uoa.local').pathname;
  } catch {
    return 'unknown';
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function sanitizeConfigJwtForHandshakeLog(configJwt: string | undefined): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  redactions: string[];
} {
  const redactions: string[] = [];
  let header: Record<string, unknown> = {};
  let payload: Record<string, unknown> = {};

  if (configJwt) {
    try {
      header = sanitizeObject(decodeProtectedHeader(configJwt), redactions, 'header');
    } catch {
      redactions.push('header_undecodable');
    }

    try {
      payload = sanitizeObject(decodeJwt(configJwt), redactions, 'payload');
    } catch {
      redactions.push('payload_undecodable');
      redactions.push('undecodable_jwt');
    }
  }

  return { header, payload, redactions };
}

function sanitizeObject(
  value: unknown,
  redactions: string[],
  path = '',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const allowedKeys = allowedKeysForPath(path);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (isSensitiveKey(key)) {
      sanitized[key] = '[redacted]';
      redactions.push(nextPath);
      continue;
    }

    if (allowedKeys && !allowedKeys.has(key)) {
      sanitized[key] = '[redacted_unrecognized]';
      redactions.push(nextPath);
      continue;
    }

    sanitized[key] = sanitizeValue(item, redactions, nextPath);
  }
  return sanitized;
}

function sanitizeValue(value: unknown, redactions: string[], path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, redactions, `${path}[${index}]`));
  }

  if (value && typeof value === 'object') {
    return sanitizeObject(value, redactions, path);
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value, redactions, path);
  }

  return value;
}

function allowedKeysForPath(path: string): ReadonlySet<string> | undefined {
  const normalized = normalizeSanitizePath(path);
  if (normalized === 'header') return safeJwtHeaderKeys;
  if (normalized === 'payload') return safeConfigJwtPayloadKeys;
  return (
    safeConfigJwtNestedKeys.get(normalized) ??
    (normalized.startsWith('payload.') ? emptyAllowedKeys : undefined)
  );
}

function normalizeSanitizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

function sanitizeStringValue(value: string, redactions: string[], path: string): string {
  if (!shouldStripUrlQuery(path)) return value;

  try {
    const url = new URL(value);
    if (url.search || url.hash) {
      url.search = '';
      url.hash = '';
      redactions.push(path);
    }
    return url.toString();
  } catch {
    const queryIndex = value.search(/[?#]/);
    if (queryIndex >= 0) {
      redactions.push(path);
      return value.slice(0, queryIndex) || '[redacted_url]';
    }
    return value;
  }
}

function shouldStripUrlQuery(path: string): boolean {
  const normalized = normalizeSanitizePath(path);
  return (
    normalized === 'payload.redirect_urls' ||
    normalized === 'payload.registration_redirect_urls' ||
    normalized.endsWith('_url') ||
    normalized.endsWith('_urls') ||
    normalized.endsWith('.url') ||
    normalized.endsWith('.font_import_url') ||
    normalized.endsWith('.admin_review_url')
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('key')
  );
}

function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : null;
}

function recordConfigVerifierError(
  request: FastifyRequest,
  params: {
    configUrl: string;
    configJwt?: string;
    phase: HandshakeErrorPhase;
    statusCode: number;
    errorCode: string;
    summary: string;
    details: string[];
    missingClaims?: string[];
    requestJson?: Record<string, unknown>;
    responseJson?: Record<string, unknown>;
    extraRedactions?: string[];
  },
): Promise<void> {
  const { header, payload, redactions } = sanitizeConfigJwtForHandshakeLog(params.configJwt);
  const domain = requestHost(params.configUrl);
  const allRedactions = [...redactions, ...(params.extraRedactions ?? [])];

  return recordHandshakeErrorLog({
    domain,
    endpoint: endpointPath(request),
    phase: params.phase,
    statusCode: params.statusCode,
    errorCode: params.errorCode,
    summary: params.summary,
    details: params.details,
    missingClaims: params.missingClaims ?? [],
    ip: request.ip,
    userAgent: userAgent(request),
    requestId: randomUUID(),
    requestJson: buildHandshakeRequestJson({
      request,
      configUrl: params.configUrl,
      redactions: allRedactions,
      configFetchRequest: params.requestJson,
    }),
    responseJson: params.responseJson ?? {},
    jwtHeader: header,
    jwtPayload: payload,
    redactions: [...new Set(allRedactions)],
  }).catch((err) => {
    request.log.warn({ err }, 'failed to record handshake error');
  });
}

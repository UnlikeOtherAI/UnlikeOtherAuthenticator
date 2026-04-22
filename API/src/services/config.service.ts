import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '../utils/errors.js';
import { z } from 'zod';
import { findJwkByKidDb, importClientJwkKey, jwkToPublic } from './client-jwk.service.js';
import { getEnv } from '../config/env.js';
import { tryParseHttpUrl } from '../utils/http-url.js';
import { getAppLogger } from '../utils/app-logger.js';

const CONFIG_JWT_ALLOWED_ALGS = ['RS256'] as const;
const CONFIG_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

type ConfigJwksCacheEntry = {
  expiresAt: number;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

const configJwksCache = new Map<string, ConfigJwksCacheEntry>();

export { fetchConfigJwtFromUrl } from './config-fetch.service.js';

const RedirectUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Boolean(tryParseHttpUrl(value)));

const HexColorSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      value === 'transparent' ||
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value),
  );

const CssLengthSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value === '0' || /^[0-9]+(?:\.[0-9]+)?(px|rem|em|%)$/.test(value));

/** Safe CSS value: no semicolons, braces, url(), or expression(). */
const SafeCssValueSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !/[{};]|url\s*\(|expression\s*\(/i.test(value));

const HttpUrlOrEmptySchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value === '') return true;
    const parsed = tryParseHttpUrl(value);
    return Boolean(parsed && parsed.protocol === 'https:');
  });

const UiThemeSchema = z
  .object({
    colors: z
      .object({
        bg: HexColorSchema,
        surface: HexColorSchema,
        text: HexColorSchema,
        muted: HexColorSchema,
        primary: HexColorSchema,
        primary_text: HexColorSchema,
        border: HexColorSchema,
        danger: HexColorSchema,
        danger_text: HexColorSchema,
      })
      .passthrough(),
    radii: z
      .object({
        card: CssLengthSchema,
        button: CssLengthSchema,
        input: CssLengthSchema,
      })
      .passthrough(),
    density: z.enum(['compact', 'comfortable', 'spacious']),
    typography: z
      .object({
        font_family: z.string().trim().min(1).max(200),
        base_text_size: z.enum(['sm', 'md', 'lg']),
        font_import_url: HttpUrlOrEmptySchema.optional(),
      })
      .passthrough(),
    button: z
      .object({
        style: z.enum(['solid', 'outline', 'ghost']),
      })
      .passthrough(),
    card: z
      .object({
        style: z.enum(['plain', 'bordered', 'shadow']),
      })
      .passthrough(),
    logo: z
      .object({
        url: HttpUrlOrEmptySchema,
        alt: z.string().trim().min(1),
        text: z.string().trim().max(100).optional(),
        font_size: CssLengthSchema.optional(),
        color: HexColorSchema.optional(),
        style: z.record(SafeCssValueSchema).optional(),
      })
      .passthrough(),
    // Optional explicit overrides for advanced clients; validated if provided.
    css_vars: z.record(z.string()).optional(),
  })
  .passthrough();

const RequiredConfigSchema = z.object({
  domain: z.string().min(1),
  // Brief 6.6: validate redirect URLs from config before redirecting.
  redirect_urls: z.array(RedirectUrlSchema).min(1),
  enabled_auth_methods: z.array(z.string().min(1)).min(1),
  ui_theme: UiThemeSchema,
  // Brief: either single language or array of languages (dropdown enabled).
  language_config: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});

export type RequiredClientConfig = z.infer<typeof RequiredConfigSchema>;

const RegistrationDomainMappingSchema = z
  .array(
    z.object({
      email_domain: z.string().trim().toLowerCase().min(1),
      org_id: z.string().trim().min(1),
      team_id: z.string().trim().min(1).optional(),
    }),
  )
  .optional()
  .superRefine((entries, ctx) => {
    if (!entries) return;

    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const domain = entries[i].email_domain;
      if (seen.has(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate email_domain: ${domain}`,
          path: [i, 'email_domain'],
        });
      }
      seen.add(domain);
    }
  });

const AccessRequestConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    target_org_id: z.string().trim().min(1).optional(),
    target_team_id: z.string().trim().min(1).optional(),
    auto_grant_domains: z.array(z.string().trim().toLowerCase().min(1)).optional(),
    notify_org_roles: z.array(z.string().trim().min(1).max(50)).default(['owner', 'admin']),
    admin_review_url: z
      .string()
      .trim()
      .min(1)
      .refine((value) => Boolean(tryParseHttpUrl(value)))
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.enabled) {
      return;
    }

    if (!config.target_org_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'access_requests.target_org_id is required when access_requests.enabled=true',
        path: ['target_org_id'],
      });
    }

    if (!config.target_team_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'access_requests.target_team_id is required when access_requests.enabled=true',
        path: ['target_team_id'],
      });
    }
  });

const ClientConfigSchema = RequiredConfigSchema.extend({
  // Task 2.5: optional config fields.
  //
  // Note: property name starts with a digit, so it must be accessed using bracket notation.
  '2fa_enabled': z.boolean().optional().default(false),
  debug_enabled: z.boolean().optional().default(false),
  user_scope: z.enum(['global', 'per_domain']).optional().default('global'),
  allow_registration: z.boolean().optional().default(true),
  registration_mode: z
    .enum(['password_required', 'passwordless'])
    .optional()
    .default('password_required'),
  allowed_registration_domains: z.array(z.string().trim().toLowerCase().min(1)).min(1).optional(),
  registration_domain_mapping: RegistrationDomainMappingSchema,
  access_requests: AccessRequestConfigSchema.optional().default({
    enabled: false,
    notify_org_roles: ['owner', 'admin'],
  }),
  // Brief 8 / Phase 10.4: default language should come from the client website's selection.
  // This is the currently selected language (not the list of available languages).
  language: z.string().trim().min(1).optional(),
  session: z
    .object({
      remember_me_enabled: z.boolean().default(true),
      remember_me_default: z.boolean().default(true),
      short_refresh_token_ttl_hours: z.number().int().min(1).max(168).default(1),
      long_refresh_token_ttl_days: z.number().int().min(1).max(90).default(30),
      access_token_ttl_minutes: z.number().int().min(15).max(60).optional(),
    })
    .optional()
    .default({
      remember_me_enabled: true,
      remember_me_default: true,
      short_refresh_token_ttl_hours: 1,
      long_refresh_token_ttl_days: 30,
    }),
  org_features: z
    .object({
      enabled: z.boolean().default(false),
      groups_enabled: z.boolean().default(false),
      user_needs_team: z.boolean().default(false),
      max_teams_per_org: z.number().int().positive().max(1000).default(100),
      max_groups_per_org: z.number().int().positive().max(200).default(20),
      max_members_per_org: z.number().int().positive().max(10000).default(1000),
      max_members_per_team: z.number().int().positive().max(5000).default(200),
      max_members_per_group: z.number().int().positive().max(5000).default(500),
      max_team_memberships_per_user: z.number().int().positive().max(200).default(50),
      org_roles: z
        .array(z.string().min(1).max(50))
        .refine((roles) => roles.includes('owner'), { message: 'org_roles must include "owner"' })
        .default(['owner', 'admin', 'member']),
    })
    .optional()
    .default({
      enabled: false,
      groups_enabled: false,
      user_needs_team: false,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
    }),
}).superRefine((config, ctx) => {
  const logoUrl = config.ui_theme.logo.url.trim();
  if (logoUrl) {
    const logoHost = normalizeHostname(new URL(logoUrl).hostname);
    const configHost = normalizeHostname(config.domain);
    if (logoHost !== configHost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ui_theme.logo.url must use the same origin as config.domain',
        path: ['ui_theme', 'logo', 'url'],
      });
    }
  }

  if (config.allow_registration === false && config.registration_mode === 'passwordless') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'registration_mode "passwordless" requires allow_registration to be true',
      path: ['registration_mode'],
    });
  }

  const domains = config.allowed_registration_domains;
  if (domains) {
    const seen = new Set<string>();
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      if (seen.has(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate allowed registration domain: ${domain}`,
          path: ['allowed_registration_domains', i],
        });
      }
      seen.add(domain);
    }
  }
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

function warnUnreachableRegistrationDomainMappings(config: ClientConfig): void {
  const allowed = config.allowed_registration_domains;
  const mappings = config.registration_domain_mapping;
  if (!allowed?.length || !mappings?.length) {
    return;
  }

  const allowedSet = new Set(allowed);
  const unreachable = [...new Set(mappings.map((entry) => entry.email_domain))].filter(
    (domain) => !allowedSet.has(domain),
  );

  if (!unreachable.length) {
    return;
  }

  getAppLogger().warn(
    { domain: config.domain, unreachable },
    'registration_domain_mapping contains domains not in allowed_registration_domains',
  );
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function getConfigJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let parsed: URL;
  try {
    parsed = new URL(jwksUrl);
  } catch {
    throw new AppError('INTERNAL', 500, 'CONFIG_JWKS_URL_INVALID');
  }

  const cacheKey = parsed.toString();
  const now = Date.now();
  for (const [key, entry] of configJwksCache.entries()) {
    if (entry.expiresAt <= now) {
      configJwksCache.delete(key);
    }
  }

  const cached = configJwksCache.get(cacheKey);
  if (cached) {
    return cached.jwks;
  }

  const jwks = createRemoteJWKSet(parsed, {
    cacheMaxAge: CONFIG_JWKS_CACHE_TTL_MS,
  });
  configJwksCache.set(cacheKey, {
    expiresAt: now + CONFIG_JWKS_CACHE_TTL_MS,
    jwks,
  });
  return jwks;
}

function assertConfigJwtHeader(configJwt: string): void {
  const header = decodeProtectedHeader(configJwt);
  if (header.alg !== 'RS256') {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Task 2.3: Verify the config JWT signature using the configured JWKS.
 *
 * Resolution order for the JWT's `kid`:
 *   1. Per-domain JWKs stored in `client_domain_jwks` (added via auto-onboarding or admin).
 *   2. The deployment-level `jwksUrl` (legacy `CONFIG_JWKS_URL`) as fallback.
 */
export async function verifyConfigJwtSignature(
  configJwt: string,
  jwksUrl: string,
): Promise<JWTPayload> {
  try {
    assertConfigJwtHeader(configJwt);

    const header = decodeProtectedHeader(configJwt);
    const kid = typeof header.kid === 'string' ? header.kid : '';

    if (kid && getEnv().DATABASE_URL) {
      const dbKey = await findJwkByKidDb(kid).catch(() => null);
      if (dbKey) {
        const imported = await importClientJwkKey(jwkToPublic(dbKey.jwk));
        const { payload } = await jwtVerify(configJwt, imported, {
          algorithms: [...CONFIG_JWT_ALLOWED_ALGS],
          clockTolerance: 30,
        });
        return payload;
      }
    }

    const { payload } = await jwtVerify(configJwt, getConfigJwks(jwksUrl), {
      algorithms: [...CONFIG_JWT_ALLOWED_ALGS],
      clockTolerance: 30,
    });
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Normalize all verification failures into a generic, user-safe error.
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Task 2.8: Validate `domain` claim matches the origin of the request.
 *
 * We treat the config URL host as the deterministic "origin" for this auth initiation.
 * This prevents a client from hosting a valid config JWT for a different domain on their
 * own infrastructure.
 */
export function assertConfigDomainMatchesConfigUrl(domainClaim: string, configUrl: string): void {
  let url: URL;
  try {
    url = new URL(configUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  const domain = normalizeHostname(domainClaim);
  const originHost = normalizeHostname(url.hostname);

  if (!domain || !originHost || domain !== originHost) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Task 2.4: Validate required config fields from the verified config JWT payload.
 *
 * This asserts required keys and validates the UI theme shape so the Auth UI can be
 * fully config-driven (no hardcoded client styles).
   * Deeper validation such as domain/origin matching and redirect URL allowlisting is handled
   * in subsequent tasks.
 */
export function validateRequiredConfigFields(payload: JWTPayload): RequiredClientConfig {
  // JWTPayload is already JSON-ish but typed as unknown values; validate explicitly.
  return RequiredConfigSchema.parse(payload);
}

/**
 * Task 2.5: Parse optional config fields from the verified config JWT payload.
 *
 * Defaults:
 * - user_scope: "global"
 * - 2fa_enabled: false
 * - debug_enabled: false
 */
export function validateConfigFields(payload: JWTPayload): ClientConfig {
  // Includes required validation plus optional field parsing and defaults.
  const config = ClientConfigSchema.parse(payload);
  warnUnreachableRegistrationDomainMappings(config);
  return config;
}

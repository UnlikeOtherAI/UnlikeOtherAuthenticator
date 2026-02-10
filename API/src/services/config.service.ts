import { AppError } from '../utils/errors.js';
import { jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { tryParseHttpUrl } from '../utils/http-url.js';

const DEFAULT_CONFIG_FETCH_TIMEOUT_MS = 5_000;

const CONFIG_JWT_ALLOWED_ALGS = ['HS256', 'HS384', 'HS512'] as const;

const RedirectUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Boolean(tryParseHttpUrl(value)));

const HexColorSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value === 'transparent' || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value));

const CssLengthSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value === '0' || /^[0-9]+(?:\.[0-9]+)?(px|rem|em|%)$/.test(value));

const HttpUrlOrEmptySchema = z
  .string()
  .trim()
  .refine((value) => value === '' || Boolean(tryParseHttpUrl(value)));

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
        font_family: z.enum(['sans', 'serif', 'mono']),
        base_text_size: z.enum(['sm', 'md', 'lg']),
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
      })
      .passthrough(),
    // Optional explicit overrides for advanced clients; validated if provided.
    css_vars: z.record(z.string()).optional(),
  })
  .passthrough();

const RequiredConfigSchema = z
  .object({
    domain: z.string().min(1),
    // Brief 6.6: validate redirect URLs from config before redirecting.
    redirect_urls: z.array(RedirectUrlSchema).min(1),
    enabled_auth_methods: z.array(z.string().min(1)).min(1),
    ui_theme: UiThemeSchema,
    // Brief: either single language or array of languages (dropdown enabled).
    language_config: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
    ]),
  });

export type RequiredClientConfig = z.infer<typeof RequiredConfigSchema>;

const ClientConfigSchema = RequiredConfigSchema.extend({
  // Task 2.5: optional config fields.
  //
  // Note: property name starts with a digit, so it must be accessed using bracket notation.
  '2fa_enabled': z.boolean().optional().default(false),
  debug_enabled: z.boolean().optional().default(false),
  // Keep this as a generic string list for now; provider key validation is handled in later tasks.
  allowed_social_providers: z.array(z.string().min(1)).optional(),
  user_scope: z.enum(['global', 'per_domain']).optional().default('global'),
  // Brief 8 / Phase 10.4: default language should come from the client website's selection.
  // This is the currently selected language (not the list of available languages).
  language: z.string().trim().min(1).optional(),
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function extractJwtFromBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';

  // Common convenience: allow "Bearer <jwt>" responses.
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice('bearer '.length).trim();
  }

  // Some client backends may return JSON. Support a minimal shape without overfitting.
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const candidate =
          obj.jwt ?? obj.token ?? obj.config_jwt ?? obj.configJwt ?? obj.configJWT;
        if (typeof candidate === 'string') return candidate.trim();
      }
    } catch {
      // Fall through and treat as plain text.
    }
  }

  return trimmed;
}

export async function fetchConfigJwtFromUrl(
  configUrl: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(configUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONFIG_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/plain, application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const jwt = extractJwtFromBody(await res.text());
    if (!jwt) {
      throw new AppError('BAD_REQUEST', 400);
    }

    return jwt;
  } catch (err) {
    // Normalize fetch/network/abort errors into a generic, user-safe error.
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Task 2.3: Verify the config JWT signature using the global shared secret.
 *
 * Task 2.6: Enforce expected `aud` (auth service identifier) so config JWTs minted
 * for one auth service are not accepted by another.
 */
export async function verifyConfigJwtSignature(
  configJwt: string,
  sharedSecret: string,
  expectedAudience: string,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(configJwt, sharedSecretKey(sharedSecret), {
      algorithms: [...CONFIG_JWT_ALLOWED_ALGS],
      audience: expectedAudience,
    });
    return payload;
  } catch {
    // Normalize all verification failures into a generic, user-safe error.
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Task 2.8: Validate `domain` claim matches the origin of the request.
 *
 * We treat the config URL host as the deterministic "origin" for this auth initiation.
 * This prevents a client who knows the shared secret from minting a valid config JWT for a
 * different domain while hosting it on their own infrastructure.
 */
export function assertConfigDomainMatchesConfigUrl(
  domainClaim: string,
  configUrl: string,
): void {
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
 * Deeper validation (aud/iss enforcement, domain/origin matching, redirect URL allowlisting)
 * is handled in subsequent tasks.
 */
export function validateRequiredConfigFields(
  payload: JWTPayload,
): RequiredClientConfig {
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
  return ClientConfigSchema.parse(payload);
}

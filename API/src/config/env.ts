import { z } from 'zod';
import dotenv from 'dotenv';

// Load local development environment variables from `.env` if present.
// In production, variables should be provided by the process environment.
dotenv.config();

function normalizeAccessTokenTtl(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  return input.trim();
}

function isValidAccessTokenTtl(value: string): boolean {
  // Brief 22.10 + task 1ac35cf5: access tokens must be short-lived (configurable, e.g. 15–60 minutes).
  // Enforce minutes-only format to avoid accidental long-lived tokens via "h/d" units.
  const match = value.match(/^(\d{1,3})m$/);
  if (!match) return false;

  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes)) return false;
  return minutes >= 15 && minutes <= 60;
}

function normalizeBoolean(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0' || normalized === '') return false;
  return input;
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Public origin used when generating links sent by email (magic links, verification, reset).
    // If unset, we fall back to `http://${HOST}:${PORT}`.
    PUBLIC_BASE_URL: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DEBUG_ENABLED: z.preprocess(normalizeBoolean, z.boolean().default(false)),
    // Single global shared secret used for domain hashing and client-domain access tokens.
    SHARED_SECRET: z.string().min(32),
    // Optional override for the internal issuer/audience used by service-issued tokens.
    // Defaults to the PUBLIC_BASE_URL host, or HOST:PORT when PUBLIC_BASE_URL is unset.
    AUTH_SERVICE_IDENTIFIER: z.string().min(1).optional(),
    // Domain whose superusers may access the first-party UOA Admin panel.
    // Defaults to the resolved auth service identifier when unset.
    ADMIN_AUTH_DOMAIN: z.string().min(1).optional(),
    // Auth-service-only signing secret for first-party admin access tokens.
    ADMIN_ACCESS_TOKEN_SECRET: z.string().min(32).optional(),
    // Signed RS256 config JWT served to the first-party Admin UI. The payload must be
    // Google-only, registration-disabled, and scoped to ADMIN_AUTH_DOMAIN.
    ADMIN_CONFIG_JWT: z.string().min(1).optional(),
    // Trusted JWKS endpoint used to verify client config JWTs. Config JWTs must be RS256
    // and include a kid that resolves to a key from this JWKS.
    CONFIG_JWKS_URL: z.string().url().optional(),
    // Public JWKS JSON served from /.well-known/jwks.json. Must contain public keys only.
    CONFIG_JWKS_JSON: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    // BYPASSRLS role used for pre-context and admin DB paths (domain-hash auth, admin routes,
    // auto-onboarding, claim flow, retention pruning, etc.). Defaults to DATABASE_URL when unset,
    // so local/dev without RLS keeps working unchanged. See Docs/Requirements/row-level-security.md.
    DATABASE_ADMIN_URL: z.string().min(1).optional(),
    // Email provider abstraction (brief phase 11.1). Provider can be swapped via env without code changes.
    EMAIL_PROVIDER: z.enum(['disabled', 'smtp', 'ses', 'sendgrid']).optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    EMAIL_REPLY_TO: z.string().min(1).optional(),
    // AWS SES provider configuration.
    AWS_REGION: z.string().min(1).optional(),
    // SendGrid provider configuration.
    SENDGRID_API_KEY: z.string().min(1).optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    // "true"/"false" for whether to use implicit TLS. If unset, the provider defaults to "false".
    SMTP_SECURE: z.enum(['true', 'false']).optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    // Social providers (one set of credentials for the auth service, not per-client).
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    FACEBOOK_CLIENT_ID: z.string().min(1).optional(),
    FACEBOOK_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
    LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
    APPLE_CLIENT_ID: z.string().min(1).optional(),
    APPLE_TEAM_ID: z.string().min(1).optional(),
    APPLE_KEY_ID: z.string().min(1).optional(),
    // Apple private key contents (typically a .p8 PEM). May be provided with literal newlines
    // or with escaped newlines ("\\n") depending on the deployment environment.
    APPLE_PRIVATE_KEY: z.string().min(1).optional(),
    ACCESS_TOKEN_TTL: z.preprocess(
      normalizeAccessTokenTtl,
      z.string().default('30m').refine(isValidAccessTokenTtl, {
        message: 'ACCESS_TOKEN_TTL must be minutes-only between 15m and 60m (e.g. "30m")',
      }),
    ),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    TOKEN_PRUNE_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    LOG_RETENTION_DAYS: z.coerce.number().int().positive().max(365).default(90),
    // Brief 8 / Phase 10: AI translation service credentials (optional; the UI falls back to English if disabled).
    AI_TRANSLATION_PROVIDER: z.enum(['disabled', 'openai']).default('disabled'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).optional(),
  });

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;
let hasLoggedSesProductionWarning = false;

function maybeLogSesProductionWarning(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.EMAIL_PROVIDER !== 'ses') return;
  if (hasLoggedSesProductionWarning) return;

  hasLoggedSesProductionWarning = true;
  console.warn(
    '[email:ses]',
    'EMAIL_PROVIDER=ses in production. Ensure AWS SES production access is approved; sandbox mode silently drops unverified recipients.',
  );
}

export function parseEnv(input: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(input);
}

export function getEnv(): Env {
  // In production the environment is static, so caching is fine. In tests we mutate `process.env`
  // across suites (e.g. DATABASE_URL per test schema), so always re-parse to avoid stale values.
  if (process.env.NODE_ENV === 'test') {
    return parseEnv(process.env);
  }

  cachedEnv ??= parseEnv(process.env);
  maybeLogSesProductionWarning(cachedEnv);
  return cachedEnv;
}

function stripTrailingDot(value: string): string {
  return value.trim().replace(/\.$/, '');
}

export function getAuthServiceIdentifier(env: Env = getEnv()): string {
  const explicit = env.AUTH_SERVICE_IDENTIFIER?.trim();
  if (explicit) return stripTrailingDot(explicit);

  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    try {
      return stripTrailingDot(new URL(publicBaseUrl).host);
    } catch {
      // parseEnv intentionally keeps PUBLIC_BASE_URL loose for legacy deployments.
    }
  }

  return stripTrailingDot(`${env.HOST}:${env.PORT}`);
}

export function getAdminAuthDomain(env: Env = getEnv()): string {
  return stripTrailingDot(env.ADMIN_AUTH_DOMAIN ?? getAuthServiceIdentifier(env)).toLowerCase();
}

export function requireEnv<K extends keyof Env>(...keys: K[]): { [P in K]-?: NonNullable<Env[P]> } {
  const env = getEnv();
  const missing = keys.filter((k) => env[k] == null || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return env as unknown as { [P in K]-?: NonNullable<Env[P]> };
}

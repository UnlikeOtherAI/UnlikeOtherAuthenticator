import { z } from 'zod';
import dotenv from 'dotenv';

import { privateRs256JwkKeyId, publicRs256JwkKeyIds } from '../utils/rs256-jwk.js';
import {
  addBillingEnvironmentIssues,
  addBillingInvoiceStorageIssues,
  billingEnvShape,
} from './billing-env-validation.js';
import { normalizeBoolean } from './env-boolean.js';
import {
  addSignatureEvidenceKeyIssues,
  addSignatureStorageIssues,
  signatureEnvShape,
} from './signature-env-validation.js';

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

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Public origin used when generating links sent by email (magic links, verification, reset).
    // If unset, we fall back to `http://${HOST}:${PORT}`.
    PUBLIC_BASE_URL: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Optional access-status diagnostics; never enabled by client config or DEBUG_ENABLED.
    AUTH_ACCESS_STATUS_ENABLED: z.preprocess(normalizeBoolean, z.boolean().default(false)),
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
    // Optional allowlist (comma-separated emails) of who may bootstrap the initial
    // SUPERUSER on ADMIN_AUTH_DOMAIN. When unset/empty, the first successful
    // admin-domain login wins SUPERUSER (brief 22.5). When set, only a listed email
    // can bootstrap; all other first logins are blocked.
    ADMIN_BOOTSTRAP_EMAILS: z.string().min(1).optional(),
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
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AWS_SES_ADMIN_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SES_ADMIN_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AWS_SES_ADMIN_REGION: z.string().min(1).optional(),
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
    // Product-API bulkhead (middleware/product-api-bulkhead.ts): the per-instance cap on
    // concurrently executing product data-API requests (/org/*, /domain/*, /settings/*, ...),
    // so one product's burst can never hold every connection sign-in needs. Default 2 because
    // the pools are capped at connection_limit=3 (DATABASE_URL) and 2 (DATABASE_ADMIN_URL) per
    // instance (Docs/deploy.md): each product request holds one app connection for its tenant
    // transaction and briefly one admin connection for domain-hash auth, so two in flight
    // always leave at least one connection in each pool for /auth/*.
    PRODUCT_API_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(2),
    // How long an excess request may wait for a slot before 503 PRODUCT_API_BUSY. Kept well
    // under the 30 s request timeout so a caller gets a clear, retryable answer, not a hang.
    PRODUCT_API_QUEUE_WAIT_MS: z.coerce.number().int().min(0).max(25_000).default(3_000),
    // Queue depth beyond which excess requests are refused at once. Two slots drain roughly
    // 20-40 requests a second, so ~32 is what a 3 s budget can realistically clear; queueing
    // more only delays the same 503 and pins memory during a flood.
    PRODUCT_API_MAX_QUEUE: z.coerce.number().int().min(0).max(10_000).default(32),
    // Brief 8 / Phase 10: AI translation service credentials (optional; the UI falls back to English if disabled).
    AI_TRANSLATION_PROVIDER: z.enum(['disabled', 'openai']).default('disabled'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).optional(),
    // RS256 private JWK (JSON) shared by confidential resource-token issuance and,
    // only when explicitly enabled below, the public-client / MCP OAuth profile.
    // Its public half is served at GET /oauth/jwks.json for resource verification.
    // Key presence alone MUST NOT enable public registration/login/token routes.
    MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: z.string().min(1).optional(),
    MCP_OAUTH_PUBLIC_PROFILE_ENABLED: z.preprocess(normalizeBoolean, z.boolean().default(false)),
    // First-party config for the profile (no client config_url): the auth "domain"
    // used for tenant scope, and the auth methods offered on the login screen.
    MCP_OAUTH_DOMAIN: z.string().min(1).optional(),
    MCP_OAUTH_ENABLED_AUTH_METHODS: z.string().min(1).optional(),
    // Comma-separated OAuth scopes advertised in metadata (informational; this profile
    // grants full user context like the rest of the service). Defaults to "openid".
    MCP_OAUTH_SCOPES_SUPPORTED: z.string().min(1).optional(),
    // Optional comma-separated allowlist of resource-server URIs (RFC 8707) this profile
    // may issue tokens for. When a client supplies `resource`, it must exactly match one
    // of these; otherwise the request is rejected (invalid_target). Closes the
    // confused-deputy: a public client cannot mint a token for an arbitrary `aud`.
    MCP_OAUTH_RESOURCES_SUPPORTED: z.string().min(1).optional(),
    // Dedicated current RS256 key for content-free tariff/entitlement snapshots.
    // It is required together with the public overlap set served at
    // GET /billing/v1/jwks.json.
    TARIFF_SNAPSHOT_PRIVATE_JWK: z
      .string()
      .min(1)
      .refine((value) => privateRs256JwkKeyId(value) !== undefined, {
        message: 'TARIFF_SNAPSHOT_PRIVATE_JWK must be a private RS256 RSA JWK with a kid',
      })
      .optional(),
    // Public-only current and retired tariff snapshot verification keys. Keeping
    // both generations here makes signing-key rotation safe across cached JWKS
    // responses and mixed Cloud Run revisions.
    TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON: z
      .string()
      .min(1)
      .refine((value) => publicRs256JwkKeyIds(value) !== undefined, {
        message: 'TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON must contain public-only RS256 RSA keys',
      })
      .optional(),
    // Dedicated RS256 signer for the user access token relying parties receive.
    // Without it the token is HS256 over SHARED_SECRET, which is also the domain
    // hash secret, the refresh-token pepper, and the login_token / 2FA / social
    // bridge signing key — so it can never be published for relying parties to
    // verify against. Configuring both values switches issuance to RS256 and
    // publishes the verification key at GET /oauth/jwks.json; UOA keeps accepting
    // already-issued HS256 tokens either way. See Docs/Auth/access-token-verification.md.
    USER_ACCESS_TOKEN_PRIVATE_JWK: z
      .string()
      .min(1)
      .refine((value) => privateRs256JwkKeyId(value) !== undefined, {
        message: 'USER_ACCESS_TOKEN_PRIVATE_JWK must be a private RS256 RSA JWK with a kid',
      })
      .optional(),
    // Public-only current and retired user access-token verification keys. Both
    // generations stay here so signing-key rotation is safe across cached JWKS
    // responses, mixed Cloud Run revisions, and unexpired tokens.
    USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON: z
      .string()
      .min(1)
      .refine((value) => publicRs256JwkKeyIds(value) !== undefined, {
        message: 'USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON must contain public-only RS256 RSA keys',
      })
      .optional(),
    ...billingEnvShape,
    ...signatureEnvShape,
  })
  .superRefine((env, ctx) => {
    if (env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED && !env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK'],
        message: 'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK is required for the public OAuth profile',
      });
    }
    if (env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED && !env.MCP_OAUTH_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MCP_OAUTH_DOMAIN'],
        message: 'MCP_OAUTH_DOMAIN is required for the public OAuth profile',
      });
    }
    addBillingEnvironmentIssues(env, ctx);
    addBillingInvoiceStorageIssues(env, ctx);
    addSignatureStorageIssues(env, ctx);
    if (
      Boolean(env.USER_ACCESS_TOKEN_PRIVATE_JWK) !== Boolean(env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'],
        message:
          'USER_ACCESS_TOKEN_PRIVATE_JWK and USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON must be set together',
      });
    }
    if (env.USER_ACCESS_TOKEN_PRIVATE_JWK && env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON) {
      const privateKid = privateRs256JwkKeyId(env.USER_ACCESS_TOKEN_PRIVATE_JWK);
      const publicKids = publicRs256JwkKeyIds(env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON);
      if (privateKid && publicKids && !publicKids.includes(privateKid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'],
          message: 'user access-token public JWKS must include the current private key kid',
        });
      }
    }
    addSignatureEvidenceKeyIssues(env, ctx);
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

/** Absolute public base URL (scheme + host), used as the OAuth issuer (RFC 8414).
 *  Falls back to http://HOST:PORT for local dev when PUBLIC_BASE_URL is unset. */
export function getPublicBaseUrl(env: Env = getEnv()): string {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  const base = explicit && explicit.length > 0 ? explicit : `http://${env.HOST}:${env.PORT}`;
  return base.replace(/\/+$/, '');
}

/** Whether RS256 resource-token verification keys may be published. */
export function isOAuthAccessTokenJwksEnabled(env: Env = getEnv()): boolean {
  return Boolean(env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK);
}

/** Whether user access tokens are issued RS256 and verifiable against published keys.
 *  Off by default: without it the token stays HS256 over SHARED_SECRET, exactly as
 *  before. UOA accepts both algorithms either way, so this is safe to flip and unflip. */
export function isUserAccessTokenRs256Enabled(env: Env = getEnv()): boolean {
  return Boolean(env.USER_ACCESS_TOKEN_PRIVATE_JWK && env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON);
}

export function isTariffSnapshotJwksEnabled(env: Env = getEnv()): boolean {
  return Boolean(env.TARIFF_SNAPSHOT_PRIVATE_JWK && env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON);
}

export function isBillingAssertionJwksEnabled(env: Env = getEnv()): boolean {
  return Boolean(
    env.UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK && env.UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON,
  );
}

/** Whether a relying-party actor assertion naming only the legacy audience is refused
 *  ("enforce") or accepted and logged ("warn", the transition default). An assertion
 *  naming the exact endpoint is always accepted; an assertion naming neither is always
 *  refused, in both modes. */
export function getBillingActorAudienceMode(env: Env = getEnv()): 'warn' | 'enforce' {
  return env.BILLING_ACTOR_AUDIENCE_MODE;
}

/** Whether the public-client / MCP OAuth profile (brief §22.14) is enabled.
 * Signing/JWKS configuration alone never opens public OAuth routes. */
export function isMcpOAuthPublicProfileEnabled(env: Env = getEnv()): boolean {
  if (!env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED || !env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK) {
    return false;
  }
  const profileDomain = env.MCP_OAUTH_DOMAIN?.trim().replace(/\.$/, '').toLowerCase();
  return Boolean(profileDomain && profileDomain !== getAdminAuthDomain(env));
}

/**
 * Allowlist of resource-server URIs (RFC 8707) the MCP OAuth profile may issue tokens
 * for. Empty when MCP_OAUTH_RESOURCES_SUPPORTED is unset. Values are NOT lowercased —
 * resource URIs are case-sensitive.
 */
export function getMcpOAuthResources(env: Env = getEnv()): string[] {
  const raw = env.MCP_OAUTH_RESOURCES_SUPPORTED?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((resource) => resource.trim())
    .filter((resource) => resource.length > 0);
}

/**
 * Optional allowlist of emails permitted to bootstrap the initial SUPERUSER on
 * ADMIN_AUTH_DOMAIN. Empty when ADMIN_BOOTSTRAP_EMAILS is unset — in which case
 * any first admin-domain login wins SUPERUSER (brief 22.5).
 */
export function getAdminBootstrapEmails(env: Env = getEnv()): string[] {
  const raw = env.ADMIN_BOOTSTRAP_EMAILS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function requireEnv<K extends keyof Env>(...keys: K[]): { [P in K]-?: NonNullable<Env[P]> } {
  const env = getEnv();
  const missing = keys.filter((k) => env[k] == null || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return env as unknown as { [P in K]-?: NonNullable<Env[P]> };
}

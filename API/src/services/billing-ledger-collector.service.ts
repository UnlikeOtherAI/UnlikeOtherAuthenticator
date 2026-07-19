import { importJWK, SignJWT, type JWK, type KeyLike } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  getAuthServiceIdentifier,
  getEnv,
  getPublicBaseUrl,
  type Env,
} from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  parsePrivateRs256Jwk,
  parsePublicRs256Jwks,
  privateRs256JwkMatchesPublicJwks,
} from '../utils/rs256-jwk.js';

const ProductSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const DecimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const CustomerChargeSchema = z
  .object({
    billingProduct: ProductSchema,
    callerProduct: ProductSchema,
    currency: CurrencySchema,
    amount: DecimalSchema,
    calls: z.number().int().nonnegative(),
  })
  .passthrough();

const MonthlyComponentSchema = z
  .object({
    billingProduct: ProductSchema,
    callerProduct: ProductSchema,
    tariffId: z.string().min(1),
    tariffKey: z.string().min(1),
    tariffVersion: z.number().int().positive(),
    tariffMode: z.enum(['standard', 'free', 'at_cost', 'custom']),
    markupBps: z.number().int().nonnegative(),
    usageMultiplierBps: z.number().int().nonnegative(),
    assignmentScope: z.enum(['team', 'organisation', 'service_default']),
    assignmentId: z.string().min(1).nullable(),
    amountMinor: z.string().regex(/^(0|[1-9]\d*)$/),
    currency: CurrencySchema,
    usageBillingEnabled: z.boolean(),
    collectionMode: z.enum(['stripe', 'manual', 'none']),
    paymentCollectionEnabled: z.boolean(),
  })
  .passthrough();

export const LedgerBillingUsageSchema = z
  .object({
    schemaVersion: z.literal(4),
    product: ProductSchema,
    scope: z
      .object({
        organizationId: z.string().min(1),
        teamId: z.string().min(1).nullable(),
        userId: z.null(),
        month: MonthSchema,
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      })
      .strict(),
    totals: z
      .object({
        calls: z.number().int().nonnegative(),
        usageByService: z.array(z.record(z.unknown())),
        amounts: z.array(z.record(z.unknown())),
        customerCharges: z.array(CustomerChargeSchema),
      })
      .strict(),
    groupBy: z.literal('service'),
    breakdown: z.array(z.record(z.unknown())),
    monthlyComponents: z.array(MonthlyComponentSchema),
    snapshot: z
      .object({
        cursor: z.string().regex(/^bus_[A-Za-z0-9_-]+$/),
        capturedAt: z.string().datetime(),
        immutable: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type LedgerBillingUsage = z.infer<typeof LedgerBillingUsageSchema>;

type CollectorConfig = {
  baseUrl: string;
  appKey: string;
  appKeyId: string;
  assertionAudience: string;
  assertionIssuer: string;
  sourceDomain: string;
  privateKey: KeyLike;
  keyId: string;
};

type BillingAssertionKeyMaterial = {
  privateKey: KeyLike;
  keyId: string;
  publicJwks: { keys: JWK[] };
};

let cachedBillingAssertionKeyMaterial: BillingAssertionKeyMaterial | undefined;

async function loadBillingAssertionKeyMaterial(
  env: Env = getEnv(),
  cache = true,
): Promise<BillingAssertionKeyMaterial> {
  if (cache && cachedBillingAssertionKeyMaterial) return cachedBillingAssertionKeyMaterial;
  const privateRaw = env.UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK;
  const publicRaw = env.UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON;
  if (!privateRaw || !publicRaw) {
    throw new AppError('INTERNAL', 503, 'BILLING_ASSERTION_SIGNING_DISABLED');
  }
  const parsedPrivate = parsePrivateRs256Jwk(privateRaw);
  const parsedPublic = parsePublicRs256Jwks(publicRaw);
  if (
    !parsedPrivate ||
    !parsedPublic ||
    !privateRs256JwkMatchesPublicJwks(privateRaw, publicRaw)
  ) {
    throw new AppError('INTERNAL', 500, 'BILLING_ASSERTION_KEY_INVALID');
  }
  try {
    const privateKey = (await importJWK(parsedPrivate.jwk, 'RS256')) as KeyLike;
    await Promise.all(parsedPublic.keys.map((key) => importJWK(key, 'RS256')));
    const material = {
      privateKey,
      keyId: parsedPrivate.kid,
      publicJwks: { keys: parsedPublic.keys },
    };
    if (cache) cachedBillingAssertionKeyMaterial = material;
    return material;
  } catch {
    throw new AppError('INTERNAL', 500, 'BILLING_ASSERTION_KEY_INVALID');
  }
}

async function collectorConfig(env: Env = getEnv(), cacheKey = true): Promise<CollectorConfig> {
  if (
    !env.STRIPE_BILLING_ENABLED ||
    !env.LEDGER_BILLING_BASE_URL ||
    !env.LEDGER_BILLING_APP_KEY ||
    !env.LEDGER_BILLING_APP_KEY_ID ||
    !env.LEDGER_BILLING_ASSERTION_AUDIENCE ||
    !env.UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK ||
    !env.UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON
  ) {
    throw new AppError('INTERNAL', 503, 'LEDGER_BILLING_COLLECTOR_DISABLED');
  }
  const key = await loadBillingAssertionKeyMaterial(env, cacheKey);
  return {
    baseUrl: env.LEDGER_BILLING_BASE_URL.replace(/\/+$/, ''),
    appKey: env.LEDGER_BILLING_APP_KEY,
    appKeyId: env.LEDGER_BILLING_APP_KEY_ID,
    assertionAudience: env.LEDGER_BILLING_ASSERTION_AUDIENCE,
    assertionIssuer: getPublicBaseUrl(env),
    sourceDomain: getAuthServiceIdentifier(env),
    privateKey: key.privateKey,
    keyId: key.keyId,
  };
}

async function signServiceAssertion(
  params: {
    product: string;
    organisationId: string;
    teamId: string | null;
    billingMonth: string;
  },
  config: CollectorConfig,
  deps?: { now?: () => number },
): Promise<string> {
  const now = deps?.now?.() ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    azp: config.appKeyId,
    source_domain: config.sourceDomain,
    scope: 'billing.read',
    product: params.product,
    organization_id: params.organisationId,
    ...(params.teamId ? { team_id: params.teamId } : {}),
    billing_month: params.billingMonth,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: config.keyId,
      typ: 'uoa-billing-service+jwt',
    })
    .setIssuer(config.assertionIssuer)
    .setAudience(config.assertionAudience)
    .setSubject('uoa-billing-collector')
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(config.privateKey);
}

export function resetBillingAssertionKeyCache(): void {
  cachedBillingAssertionKeyMaterial = undefined;
}

export async function preloadBillingAssertionSigningKey(): Promise<void> {
  await loadBillingAssertionKeyMaterial();
}

export async function getBillingAssertionPublicJwks(): Promise<{ keys: JWK[] }> {
  const { keys } = (await loadBillingAssertionKeyMaterial()).publicJwks;
  return { keys: keys.map((key) => ({ ...key })) };
}

export async function fetchLedgerBillingUsage(
  params: {
    product: string;
    organisationId: string;
    teamId: string | null;
    billingMonth: string;
    cursor?: string;
  },
  deps?: {
    env?: Env;
    fetch?: typeof fetch;
    now?: () => number;
    signAssertion?: typeof signServiceAssertion;
  },
): Promise<LedgerBillingUsage> {
  const config = await collectorConfig(deps?.env, deps?.env === undefined);
  const assertion = await (deps?.signAssertion ?? signServiceAssertion)(params, config, {
    now: deps?.now,
  });
  const url = new URL(`${config.baseUrl}/v1/billing/usage`);
  url.searchParams.set('group_by', 'service');
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  let response: Response;
  try {
    response = await (deps?.fetch ?? fetch)(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Ledger-App-Key': config.appKey,
        'X-UOA-Service-Assertion': assertion,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_REQUEST_FAILED');
  }
  if (!response.ok) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_REQUEST_FAILED');
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_RESPONSE_TOO_LARGE');
  }
  try {
    return LedgerBillingUsageSchema.parse(JSON.parse(text));
  } catch {
    throw new AppError('INTERNAL', 502, 'LEDGER_BILLING_RESPONSE_INVALID');
  }
}

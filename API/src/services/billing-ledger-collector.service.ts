import { createHash, randomUUID } from 'node:crypto';

import { importJWK, SignJWT, type JWK, type KeyLike } from 'jose';
import { z } from 'zod';

import { getAuthServiceIdentifier, getEnv, getPublicBaseUrl, type Env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  parsePrivateRs256Jwk,
  parsePublicRs256Jwks,
  privateRs256JwkMatchesPublicJwks,
} from '../utils/rs256-jwk.js';
import type { NormalizedMeteringUsage, RawMeteringLine } from './billing-metering.types.js';

const ProductSchema = z.enum(['nessie', 'deepwater', 'deepsignal', 'deeptest']);
const IntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const DecimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const ProductDimensionsSchema = z
  .object({
    billingProduct: ProductSchema,
    callerProduct: ProductSchema.nullable(),
    originProduct: ProductSchema.nullable(),
  })
  .strict();

const UsageRowSchema = ProductDimensionsSchema.extend({
  serviceId: z.string().trim().min(1).max(512),
  usageUnit: z.string().trim().min(1).max(512),
  calls: IntegerSchema,
  rawProviderUsage: z
    .object({
      unitsIn: IntegerSchema,
      unitsCachedIn: IntegerSchema,
      unitsOut: IntegerSchema,
    })
    .strict(),
}).strict();

const CostFieldsSchema = {
  costProvenance: z.string().trim().min(1).max(512),
  rawProviderCurrency: CurrencySchema.nullable(),
  rawProviderEstimatedCost: DecimalSchema.nullable(),
  rawProviderActualCost: DecimalSchema.nullable(),
} as const;

const CostRowSchema = ProductDimensionsSchema.extend({
  serviceId: z.string().trim().min(1).max(512),
  calls: IntegerSchema,
  ...CostFieldsSchema,
}).strict();

const BreakdownRowSchema = UsageRowSchema.extend({
  dimension: z.string().trim().min(1).max(512).nullable(),
  ...CostFieldsSchema,
}).strict();

export const LedgerMeteringUsageSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: ProductSchema,
    scope: z
      .object({
        organizationId: z.string().trim().min(1).max(256),
        teamId: z.string().trim().min(1).max(256).nullable(),
        userId: z.string().trim().min(1).max(256).nullable(),
        month: MonthSchema.nullable(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
      })
      .strict(),
    totals: z
      .object({
        calls: IntegerSchema,
        usageByService: z.array(UsageRowSchema),
        costs: z.array(CostRowSchema),
      })
      .strict(),
    groupBy: z.enum(['service', 'user']),
    breakdown: z.array(BreakdownRowSchema),
    snapshot: z
      .object({
        cursor: z.string().regex(/^mus_[A-Za-z0-9_-]{32}$/),
        id: z.string().regex(/^mus_[A-Za-z0-9_-]{32}$/),
        capturedAt: z.string().datetime(),
        immutable: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshot.cursor !== value.snapshot.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot', 'id'],
        message: 'snapshot id must equal cursor',
      });
    }
  });

export type LedgerMeteringUsage = z.infer<typeof LedgerMeteringUsageSchema>;

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
  if (!parsedPrivate || !parsedPublic || !privateRs256JwkMatchesPublicJwks(privateRaw, publicRaw)) {
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
    !env.LEDGER_BILLING_BASE_URL ||
    !env.LEDGER_BILLING_APP_KEY ||
    !env.LEDGER_BILLING_APP_KEY_ID ||
    !env.LEDGER_BILLING_ASSERTION_AUDIENCE
  ) {
    throw new AppError('INTERNAL', 503, 'LEDGER_METERING_READER_DISABLED');
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
    scope: 'metering.read',
    product: params.product,
    organization_id: params.organisationId,
    ...(params.teamId ? { team_id: params.teamId } : {}),
    billing_month: params.billingMonth,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: config.keyId,
      typ: 'uoa-metering-service+jwt',
    })
    .setIssuer(config.assertionIssuer)
    .setAudience(config.assertionAudience)
    .setSubject('uoa-metering-reader')
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(config.privateKey);
}

function normalizeLine(
  line: z.infer<typeof BreakdownRowSchema>,
  groupBy: 'service' | 'user',
): RawMeteringLine {
  return {
    serviceId: line.serviceId,
    usageUnit: line.usageUnit,
    calls: line.calls,
    inputUnits: line.rawProviderUsage.unitsIn,
    cachedInputUnits: line.rawProviderUsage.unitsCachedIn,
    outputUnits: line.rawProviderUsage.unitsOut,
    estimatedProviderCost: line.rawProviderEstimatedCost,
    actualProviderCost: line.rawProviderActualCost,
    currency: line.rawProviderCurrency,
    costProvenance: line.costProvenance,
    billingProduct: line.billingProduct,
    callerProduct: line.callerProduct ?? line.billingProduct,
    originProduct: line.originProduct ?? line.callerProduct ?? line.billingProduct,
    userId: groupBy === 'user' ? line.dimension : null,
  };
}

function normalizeUsage(usage: LedgerMeteringUsage, sha256: string): NormalizedMeteringUsage {
  return {
    schemaVersion: 1,
    product: usage.product,
    groupBy: usage.groupBy,
    scope: usage.scope,
    calls: usage.totals.calls,
    lines: usage.breakdown.map((line) => normalizeLine(line, usage.groupBy)),
    snapshot: {
      cursor: usage.snapshot.cursor,
      id: usage.snapshot.id,
      capturedAt: usage.snapshot.capturedAt,
      immutable: true,
      sha256,
    },
  };
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

export async function fetchLedgerMeteringUsage(
  params: {
    product: string;
    organisationId: string;
    teamId: string | null;
    billingMonth: string;
    groupBy: 'service' | 'user';
    cursor?: string;
  },
  deps?: {
    env?: Env;
    fetch?: typeof fetch;
    now?: () => number;
    signAssertion?: typeof signServiceAssertion;
  },
): Promise<NormalizedMeteringUsage> {
  const config = await collectorConfig(deps?.env, deps?.env === undefined);
  const assertion = await (deps?.signAssertion ?? signServiceAssertion)(params, config, {
    now: deps?.now,
  });
  const url = new URL(`${config.baseUrl}/v1/metering/usage`);
  url.searchParams.set('group_by', params.groupBy);
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
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_REQUEST_FAILED');
  }
  if (!response.ok) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_REQUEST_FAILED');
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_RESPONSE_TOO_LARGE');
  }
  try {
    const usage = LedgerMeteringUsageSchema.parse(JSON.parse(text));
    if (
      usage.product !== params.product ||
      usage.groupBy !== params.groupBy ||
      usage.scope.organizationId !== params.organisationId ||
      usage.scope.teamId !== params.teamId ||
      usage.scope.userId !== null ||
      usage.scope.month !== params.billingMonth
    ) {
      throw new Error('scope mismatch');
    }
    return normalizeUsage(usage, createHash('sha256').update(text).digest('hex'));
  } catch {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_RESPONSE_INVALID');
  }
}

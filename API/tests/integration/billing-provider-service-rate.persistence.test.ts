import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  finalizePrepaidDispatch, reservePrepaidDispatch,
} from '../../src/services/billing-prepaid-reservation.service.js';
import { createBillingService, createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { serializeBillingTariff } from '../../src/routes/internal/admin/billing-serialization.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { createTestDb } from '../helpers/test-db.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ids = {
  user: 'usr_cloud_browser', org: 'org_cloud_browser', team: 'team_cloud_browser',
  service: 'svc_cloud_browser', tariff: 'tariff_cloud_browser', account: 'acct_cloud_browser',
  customer: 'customer_cloud_browser', credit: 'credit_cloud_browser', key: 'ledger_key_cloud_browser',
};
const secret = `uoa_ledger_${'s'.repeat(43)}`;
const source = 'app.salesnerd.live';
const issuer = 'https://authentication.unlikeotherai.com';
const startedAt = '2026-10-10T12:00:00.000Z';
let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let signingKey: KeyLike;
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

async function delegation() {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ tv: 0, email: 'browser@example.com', source_domain: source, azp: source,
    product: 'salesnerd', scope: 'ai.invoke', active: { orgId: ids.org, teamId: ids.team },
    org: { org_id: ids.org, org_role: 'owner', teams: [ids.team], team_roles: { [ids.team]: 'admin' } } })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'cloud-browser-key' })
    .setIssuer(issuer).setAudience('https://ledger.example.com').setSubject(ids.user)
    .setJti(`cloud-browser-${Math.random()}`).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 45)
    .sign(signingKey);
}

function admission(dispatchId: string, providerServiceId: string, rawCostBound: string) {
  return { dispatchId, requestFingerprint: createHash('sha256').update(dispatchId).digest('hex'),
    dispatchStartedAt: startedAt, product: 'salesnerd', providerServiceId,
    organisationId: ids.org, teamId: ids.team, userId: ids.user, rawCostBound, currency: 'USD' };
}

async function seed() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO "users" ("id", "email", "user_key", "name")
      VALUES (${ids.user}, 'browser@example.com', 'browser@example.com', 'Browser')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "organisations" ("id", "domain", "name", "slug", "owner_id", "updated_at")
      VALUES (${ids.org}, ${source}, 'Browser', 'browser', ${ids.user}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "teams" ("id", "org_id", "name", "slug", "updated_at")
      VALUES (${ids.team}, ${ids.org}, 'Browser', 'browser', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO org_members (id, org_id, user_id, domain, role, updated_at)
      VALUES ('org-member-browser', ${ids.org}, ${ids.user}, ${source}, 'owner', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO team_members (id, team_id, user_id, team_role, updated_at)
      VALUES ('team-member-browser', ${ids.team}, ${ids.user}, 'admin', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_services" ("id", "identifier", "name", "tariff_history_from_month", "updated_at")
      VALUES (${ids.service}, 'salesnerd', 'SalesNerd', '2026-10', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_tariffs" ("id", "service_id", "key", "version", "name", "mode",
      "collection_mode", "markup_bps", "currency", "usage_payment_mode")
      VALUES (${ids.tariff}, ${ids.service}, 'prepaid', 1, 'Prepaid', 'STANDARD', 'NONE', 3000, 'USD', 'PREPAID')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_stripe_accounts" ("id", "stripe_account_id", "livemode", "updated_at")
      VALUES (${ids.account}, 'acct_cloud_browser', false, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_stripe_customers" ("id", "account_id", "org_id", "team_id", "scope", "scope_key", "updated_at")
      VALUES (${ids.customer}, ${ids.account}, ${ids.org}, ${ids.team}, 'TEAM', ${`${ids.org}:${ids.team}`}, CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO "billing_credit_accounts" ("id", "account_id", "customer_id", "org_id", "team_id",
      "scope", "scope_key", "currency", "balance_microcredits", "updated_at")
      VALUES (${ids.credit}, ${ids.account}, ${ids.customer}, ${ids.org}, ${ids.team}, 'TEAM',
        ${`${ids.org}:${ids.team}`}, 'USD', 1000000000, CURRENT_TIMESTAMP)`);
  });
  await prisma.billingTariffProviderServiceRate.create({ data: { tariffId: ids.tariff,
    providerServiceId: 'browserbase', markupBps: 2000, lineKind: 'CLOUD_BROWSER' } });
  await prisma.billingLedgerRuntimeKey.create({ data: { id: ids.key, serviceId: ids.service,
    secretDigest: createHash('sha256').update(secret).digest('hex'), keyPrefix: secret.slice(0, 18),
    ledgerAudience: 'https://ledger.example.com', sourceDomain: source, createdByEmail: 'admin@example.com' } });
  await prisma.billingTariffTermEvent.create({ data: { serviceId: ids.service, source: 'SERVICE_DEFAULT',
    scopeKey: ids.service, effectiveFromMonth: '2026-10', tariffId: ids.tariff, reason: 'Cloud browser proof' } });
}

describe.skipIf(!enabled)('connected provider-service rates in PostgreSQL', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    signingKey = pair.privateKey;
    const jwk = await exportJWK(pair.privateKey);
    Object.assign(jwk, { kid: 'cloud-browser-key', alg: 'RS256', use: 'sig' });
    process.env.PUBLIC_BASE_URL = issuer;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(jwk);
    resetAccessTokenKeyCache();
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required');
    prisma = db.prisma;
    cleanup = db.cleanup;
    await seed();
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (cleanup) await cleanup();
  });

  it('holds and settles cloud browser minutes at 20 percent while other usage keeps the tariff markup', async () => {
    const deps = { prisma, now: new Date(startedAt) };
    const browser = await reservePrepaidDispatch({ runtimeSecret: secret, delegation: await delegation(),
      input: admission('pd_cloud_browser_1', 'browserbase', '0.012') }, deps);
    expect(browser).toMatchObject({ payment_mode: 'prepaid', reserved_microcredits: '14400000' });
    const model = await reservePrepaidDispatch({ runtimeSecret: secret, delegation: await delegation(),
      input: admission('pd_cloud_model_1', 'openai', '0.012') }, deps);
    expect(model).toMatchObject({ payment_mode: 'prepaid', reserved_microcredits: '15600000' });

    const settled = await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: 'pd_cloud_browser_1',
      receiptId: 'le_pd_cloud_browser_1', kind: 'settle', rawCostActual: '0.006', currency: 'USD' }, { prisma });
    expect(settled).toMatchObject({ status: 'SETTLED', debited_microcredits: '7200000' });
    const liability = await prisma.billingPaidUsageLiability.findUniqueOrThrow({ where: { dispatchId: 'pd_cloud_browser_1' } });
    expect(liability).toMatchObject({ providerServiceId: 'browserbase', frozenMarkupBps: 2000,
      tariffId: ids.tariff, ratedMicrocredits: 7_200_000n });
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({ where: { id: ids.credit } }))
      .balanceMicrocredits).toBe(1_000_000_000n - 7_200_000n);
    await finalizePrepaidDispatch({ runtimeSecret: secret, dispatchId: 'pd_cloud_model_1',
      receiptId: 'le_pd_cloud_model_1', kind: 'release' }, { prisma });
  });

  it('keeps rates immutable and only on prepaid standard or custom versions', async () => {
    await expect(prisma.billingTariffProviderServiceRate.updateMany({ where: { tariffId: ids.tariff },
      data: { markupBps: 0 } })).rejects.toThrow();
    await expect(prisma.billingTariffProviderServiceRate.deleteMany({ where: { tariffId: ids.tariff } })).rejects.toThrow();
    await prisma.$executeRaw(Prisma.sql`INSERT INTO "billing_tariffs" ("id", "service_id", "key", "version", "name", "mode",
      "collection_mode", "markup_bps", "currency", "usage_payment_mode")
      VALUES ('tariff_cloud_browser_payg', ${ids.service}, 'payg', 1, 'PAYG', 'STANDARD', 'NONE', 3000, 'USD', 'PAY_AS_YOU_GO')`);
    await expect(prisma.billingTariffProviderServiceRate.create({ data: { tariffId: 'tariff_cloud_browser_payg',
      providerServiceId: 'browserbase', markupBps: 2000, lineKind: 'CLOUD_BROWSER' } })).rejects.toThrow();
  });

  it('creates a product with its cloud browser rate through the operator service and serializes it for operators only', async () => {
    const service = await createBillingService({ identifier: 'salesnerd-proof', name: 'SalesNerd proof',
      defaultTariff: { key: 'standard', name: 'Standard', mode: 'standard', collectionMode: 'none',
        monthlyAmountMinor: '0', usagePaymentMode: 'prepaid', currency: 'USD',
        providerServiceRates: [{ providerServiceId: 'browserbase', markupBps: 2000, lineKind: 'cloud_browser' }] },
      actor: { email: 'operator@example.com' } }, { prisma });
    const tariff = service.tariffs[0];
    if (!tariff) throw new Error('tariff');
    expect(serializeBillingTariff(tariff)).toMatchObject({ markup_percent: '30.00', usage_payment_mode: 'prepaid',
      provider_service_rates: [{ provider_service_id: 'browserbase', markup_bps: 2000, markup_percent: '20.00',
        line_kind: 'cloud_browser' }] });
    await expect(createBillingTariffVersion({ serviceId: service.id, setAsDefault: false,
      tariff: { key: 'payg', name: 'PAYG', mode: 'standard', collectionMode: 'none', monthlyAmountMinor: '0',
        usagePaymentMode: 'pay_as_you_go', currency: 'USD',
        providerServiceRates: [{ providerServiceId: 'browserbase', markupBps: 2000, lineKind: 'cloud_browser' }] },
      actor: { email: 'operator@example.com' } }, { prisma })).rejects.toThrow('BILLING_PROVIDER_SERVICE_RATES_REQUIRE_PREPAID');
  });
});

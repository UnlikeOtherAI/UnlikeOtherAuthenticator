import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestDb } from './test-db.js';
import { browserFinancialFixture } from './browser-financial-fixture.js';
import { smsIds } from './sms-financial-fixture.js';
import { seedDomainSecret } from './domain-secret.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { registerBrowserBillingRoutes } from '../../src/routes/billing/browser.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { requireStripeBillingEnabled } from '../../src/services/billing-stripe-client.service.js';
import { generateBillingAppKey, digestBillingAppKey } from '../../src/utils/billing-app-key.js';
import { billingReservedMicrocredits } from '../../src/services/billing-credit-holds.service.js';

type Opened = { browserId: string; sessionId: string; browserbaseSessionId: string; joined: boolean };
export type NessieBrowserContract = {
  open(options?: { shared?: boolean; seconds?: number; asAgent?: boolean }): Promise<Opened>;
  release(sessionId: string): Promise<boolean>;
  reconcile(browserId: string): Promise<void>;
  reap(): Promise<void>;
  readBrowser(browserId: string): Promise<{ billingState: string; status: string }>;
  quote(): Promise<{ customer_price_per_minute: string }>;
  cleanup(): Promise<void>;
  loseNextCreate(): void;
  providerRows(): Array<{ id: string; startedAt: string; userMetadata: { nessieBrowserId: string } }>;
  requests: Array<{ method: string; path: string }>;
};

/** Real HTTP routes, signature/purpose/assurance checks and two real databases.
 * Opening credit and Stripe account identity are synthetic; no top-up or live provider is exercised. */
export async function browserNessieContract() {
  const db = (await createTestDb())!;
  let app: ReturnType<typeof Fastify> | undefined;
  let nessie: NessieBrowserContract | undefined;
  const cleanup = async () => {
    vi.useRealTimers();
    try {
      try { await nessie?.cleanup(); } finally { await app?.close(); }
    } finally {
      try { await disconnectPrisma(); await db.cleanup(); } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  };
  try {
    await disconnectPrisma();
    vi.stubEnv('DATABASE_URL', db.databaseUrl);
    vi.stubEnv('DATABASE_ADMIN_URL', db.databaseUrl);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://billing-contract.example.com');
    vi.stubEnv('DEBUG_ENABLED', 'false');
    const f = await browserFinancialFixture(db.prisma, 6600000n);
    const runtime = requireStripeBillingEnabled('live');
    vi.spyOn(runtime.client.accounts, 'retrieveCurrent').mockImplementation(() => f.stripe.accounts.retrieveCurrent());
    const domain = 'browser-contract.example.com';
    const issuer = `https://${domain}`;
    const domainKey = await seedDomainSecret(db.prisma, domain, 'synthetic-domain-secret');
    await db.prisma.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 2 } });
    const familyId = randomUUID(), now = new Date(), expiresAt = new Date(now.getTime() + 3600_000);
    await issueRefreshToken({ familyId, userId: smsIds.user, domain, clientId: domainKey,
      configUrl: `${issuer}/config`, orgId: smsIds.org, teamId: smsIds.team, twoFaCompleted: false },
    { prisma: db.prisma, refreshTokenTtlDays: 1 });
    const proof = await db.prisma.$transaction(tx => issueSessionAssurance({ familyId, userId: smsIds.user,
      clientDomain: domain, credentialEpoch: 0, orgId: smsIds.org, teamId: smsIds.team,
      method: 'independent', observedAt: now, authenticatedAt: now, mfaSource: 'none', amr: ['pwd'],
      expiresAt, policyGeneration: 0 }, tx));
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), kid = 'browser-contract-actor';
    const appKey = generateBillingAppKey();
    await db.prisma.billingAppKey.update({ where: { id: f.credential.id }, data: {
      keyPrefix: appKey.slice(0, 16), secretDigest: digestBillingAppKey(appKey), actorIssuer: issuer,
      actorAudience: process.env.PUBLIC_BASE_URL!, actorKeyId: kid,
      actorPublicJwk: { ...pair.publicKey.export({ format: 'jwk' }), kid } as Prisma.InputJsonValue,
    } });
    app = Fastify();
    registerErrorHandler(app);
    registerBrowserBillingRoutes(app);
    await app.ready();
    let loseReceipt = false;
    const statuses: Array<{ path: string; status: number }> = [];
    const env = { NODE_ENV: 'test', UOA_BASE_URL: process.env.PUBLIC_BASE_URL!, UOA_DOMAIN: domain,
      NESSIE_API_PUBLIC_URL: issuer, UOA_BROWSER_RUNTIME_APP_KEY_NESSIE: appKey,
      UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE: JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid }) };
    const transport = async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe(env.UOA_BASE_URL);
      const response = await app!.inject({ method: 'POST', url: url.pathname,
        headers: Object.fromEntries(new Headers(init.headers)), payload: String(init.body) });
      statuses.push({ path: url.pathname, status: response.statusCode });
      if (loseReceipt && url.pathname.endsWith('/receipt') && response.statusCode === 200) {
        loseReceipt = false;
        throw new Error('Synthetic response loss after UOA committed settlement');
      }
      return new Response(response.body, { status: response.statusCode,
        headers: { 'Content-Type': 'application/json' } });
    };
    // Node loads the other checkout's built modules with its own dependency graph.
    // Vite's module loader must not transform or resolve that external repository.
    const loaded = createRequire(import.meta.url)(resolve(process.env.NESSIE_BROWSER_CONTRACT_ROOT!,
      'packages/team-admin/test/browser-contract-fixture.mjs')) as {
      browserContractFixture(config: Record<string, unknown>): Promise<NessieBrowserContract>;
    };
    nessie = await loaded.browserContractFixture({ env, transport,
      databaseUrl: process.env.NESSIE_BROWSER_CONTRACT_DATABASE_URL!, subject: f.subject, projectId: f.project,
      assurance: { id: proof.assurance.id, reference: proof.reference, expiresAt: expiresAt.toISOString() },
      beforeCreate: async (dispatchId: string) => {
        const row = await db.prisma.billingBrowserReservation.findUniqueOrThrow({ where: { dispatchId } });
        expect(row).toMatchObject({ state: 'dispatching', userId: smsIds.user, teamId: smsIds.team,
          creditAccountId: smsIds.credit, policyId: f.policy.id });
        expect(await billingReservedMicrocredits(db.prisma, smsIds.credit)).toBeGreaterThanOrEqual(row.reservedMicrocredits);
      },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    return { db, f, nessie, env, statuses,
      loseNextReceipt: () => { loseReceipt = true; },
      cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}

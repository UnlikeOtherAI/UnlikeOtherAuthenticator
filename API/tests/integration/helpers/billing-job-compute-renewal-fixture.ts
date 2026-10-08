import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair } from 'jose';
import { createTestDb } from '../../helpers/test-db.js';
import { digestBillingAppKey } from '../../../src/utils/billing-app-key.js';
import {
  resetAccessTokenKeyCache,
  signConfidentialAccessToken,
} from '../../../src/services/oauth/access-token.service.js';
import type { JobComputeIdentity } from '../../../src/services/billing-job-compute-renewal.service.js';
export const enabled = Boolean(process.env.DATABASE_URL);
export const secret = `uoa_job_${'a'.repeat(43)}`;
export const appKey = `uoa_app_${'b'.repeat(43)}`;
export const runtimeSecret = `uoa_ledger_${'d'.repeat(43)}`;
export const waterRuntimeSecret = `uoa_ledger_${'e'.repeat(43)}`;
export const salesRuntimeSecret = `uoa_ledger_${'f'.repeat(43)}`;
export const salesSourceDomain = 'app.salesnerd.live';
export const salesOrgId = 'org-job-sales';
export const salesTeamId = 'team-job-sales';
export const grantId = 'b6b40179-e4e4-4fdd-ad6f-9067f6127110';
export const grantUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const identity: JobComputeIdentity = {
  originInvocationId: 'inv-job-compute-test',
  ledgerJobId: 'ledger-job-compute-test',
  waterJobId: '12345678-1234-4123-8123-123456789abc',
  scopeTurnId: null,
  purpose: 'research_compute',
};
export let db: PrismaClient;
export let cleanup: () => Promise<void>;
export let salesClientDomainId: string;
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

export function freshOriginalDelegation() {
  return signConfidentialAccessToken({
    subject: 'subject-job-test',
    credentialEpoch: 0,
    email: 'job@example.com',
    sourceDomain: 'api.nessie.works',
    product: 'nessie',
    resource: 'https://ledger.unlikeotherai.com',
    issuer: 'https://authentication.unlikeotherai.com',
    ttlSeconds: 45,
    scope: 'ai.invoke',
    active: { orgId: 'org-job-test', teamId: 'team-job-test' },
    org: {
      org_id: 'org-job-test',
      tenant_slug: 'job-test',
      org_role: 'owner',
      teams: ['team-job-test'],
      team_roles: { 'team-job-test': 'owner' },
    },
  });
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function waitForEpochLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND datname = current_database()
        AND (query LIKE '%pg_advisory_xact_lock(hashtextextended%'
          OR query LIKE '%pg_advisory_xact_lock_shared(hashtextextended%')
    `);
    if ((rows[0]?.count ?? 0n) >= BigInt(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Expected ${expected} transactions to wait on the authentication epoch lock.`);
}
export async function setupJobComputeFixture() {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  Object.assign(privateJwk, { kid: 'job-compute-test', alg: 'RS256', use: 'sig' });
  process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  resetAccessTokenKeyCache();
  const handle = await createTestDb();
  if (!handle) throw new Error('DATABASE_URL required');
  db = handle.prisma;
  cleanup = handle.cleanup;
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw(Prisma.sql`INSERT INTO billing_services
    (id, identifier, name, updated_at) VALUES
    ('svc-job-origin', 'nessie', 'Nessie', CURRENT_TIMESTAMP),
    ('svc-job-sales', 'salesnerd', 'SalesNerd', CURRENT_TIMESTAMP),
    ('svc-job-water', 'deepwater', 'Water', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO users
    (id, email, user_key, name) VALUES
    ('subject-job-test', 'job@example.com', 'job@example.com', 'Job')`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO organisations
    (id, domain, name, slug, owner_id, updated_at) VALUES
    ('org-job-test', 'api.nessie.works', 'Job', 'job-test', 'subject-job-test', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO organisations
    (id, domain, name, slug, owner_id, updated_at) VALUES
    (${salesOrgId}, ${salesSourceDomain}, 'Sales', 'sales-job-test', 'subject-job-test', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO teams
    (id, org_id, name, slug, updated_at) VALUES
    ('team-job-test', 'org-job-test', 'Job', 'job-test', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO teams
    (id, org_id, name, slug, updated_at) VALUES
    (${salesTeamId}, ${salesOrgId}, 'Sales', 'sales-job-test', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
    (id, org_id, user_id, domain, role, updated_at) VALUES
    ('org-member-job', 'org-job-test', 'subject-job-test', 'api.nessie.works', 'owner', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
    (id, org_id, user_id, domain, role, updated_at) VALUES
    ('org-member-sales-job', ${salesOrgId}, 'subject-job-test', ${salesSourceDomain}, 'owner', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
    (id, team_id, user_id, team_role, updated_at) VALUES
    ('team-member-job', 'team-job-test', 'subject-job-test', 'owner', CURRENT_TIMESTAMP)`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
    (id, team_id, user_id, team_role, updated_at) VALUES
    ('team-member-sales-job', ${salesTeamId}, 'subject-job-test', 'owner', CURRENT_TIMESTAMP)`);
    await tx.domainRole.create({
      data: { domain: 'api.nessie.works', userId: 'subject-job-test', role: 'USER' },
    });
    await tx.domainRole.create({
      data: { domain: salesSourceDomain, userId: 'subject-job-test', role: 'USER' },
    });
    const origin = await tx.clientDomain.create({
      data: { domain: 'api.nessie.works', label: 'Nessie', status: 'active' },
    });
    const sales = await tx.clientDomain.create({
      data: { domain: salesSourceDomain, label: 'SalesNerd', status: 'active' },
    });
    salesClientDomainId = sales.id;
    const recipient = await tx.clientDomain.create({
      data: { domain: 'api.deepwater.live', label: 'Water', status: 'active' },
    });
    for (const [clientDomainId, product] of [
      [origin.id, 'nessie'],
      [sales.id, 'salesnerd'],
      [recipient.id, 'deepwater'],
    ] as const) {
      await tx.confidentialDelegationMapping.create({
        data: {
          clientDomainId,
          product,
          resource: 'https://ledger.unlikeotherai.com',
          scopes: ['AI_INVOKE'],
          enabled: true,
        },
      });
    }
    await tx.billingLedgerRuntimeKey.create({
      data: {
        id: 'key-job-origin',
        serviceId: 'svc-job-origin',
        secretDigest: createHash('sha256').update(runtimeSecret).digest('hex'),
        keyPrefix: runtimeSecret.slice(0, 18),
        ledgerAudience: 'https://ledger.unlikeotherai.com',
        sourceDomain: 'api.nessie.works',
        createdByEmail: 'admin@example.com',
      },
    });
    await tx.billingLedgerRuntimeKey.create({
      data: {
        id: 'key-job-sales',
        serviceId: 'svc-job-sales',
        secretDigest: createHash('sha256').update(salesRuntimeSecret).digest('hex'),
        keyPrefix: salesRuntimeSecret.slice(0, 18),
        ledgerAudience: 'https://ledger.unlikeotherai.com',
        sourceDomain: salesSourceDomain,
        createdByEmail: 'admin@example.com',
      },
    });
    await tx.billingLedgerRuntimeKey.create({
      data: {
        id: 'key-job-water',
        serviceId: 'svc-job-water',
        secretDigest: createHash('sha256').update(waterRuntimeSecret).digest('hex'),
        keyPrefix: waterRuntimeSecret.slice(0, 18),
        ledgerAudience: 'https://ledger.unlikeotherai.com',
        sourceDomain: 'api.deepwater.live',
        createdByEmail: 'admin@example.com',
      },
    });
    await tx.billingAppKey.create({
      data: {
        id: 'app-key-job-water',
        serviceId: 'svc-job-water',
        purpose: 'CUSTOMER_LIFECYCLE',
        name: 'Water lifecycle',
        keyPrefix: appKey.slice(0, 16),
        secretDigest: digestBillingAppKey(appKey),
        actorIssuer: 'https://api.deepwater.live',
        actorAudience: 'https://authentication.unlikeotherai.com/billing',
        actorKeyId: 'water-key',
        actorPublicJwk: {},
        checkoutReturnOrigins: ['https://api.deepwater.live'],
      },
    });
    await tx.billingJobComputeRenewal.create({
      data: {
        id: grantId,
        issueKey: '1'.repeat(64),
        identityKey: '2'.repeat(64),
        secretDigest: createHash('sha256').update(secret).digest('hex'),
        originRuntimeKeyId: 'key-job-origin',
        originProduct: 'nessie',
        originSourceDomain: 'api.nessie.works',
        identityDomain: 'api.nessie.works',
        subjectId: 'subject-job-test',
        orgId: 'org-job-test',
        teamId: 'team-job-test',
        tokenVersion: 0,
        originTokenJti: 'original-token-job-test',
        originInvocationId: identity.originInvocationId,
        ledgerJobId: identity.ledgerJobId,
        waterJobId: identity.waterJobId,
        scopeTurnId: null,
        purpose: identity.purpose,
        recipientOrigin: 'https://api.deepwater.live',
        recipientProduct: 'deepwater',
        ledgerAudience: 'https://ledger.unlikeotherai.com',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  });
}

export async function salesParentDelegation(input: {
  grantHandle: string;
  requestId: string;
  jobId: string;
  authorizedUntil: Date;
}): Promise<string> {
  return signConfidentialAccessToken({
    subject: 'subject-job-test',
    credentialEpoch: 0,
    email: 'job@example.com',
    sourceDomain: salesSourceDomain,
    product: 'salesnerd',
    resource: 'https://ledger.unlikeotherai.com',
    issuer: 'https://authentication.unlikeotherai.com',
    ttlSeconds: 45,
    scope: 'ai.invoke',
    active: { orgId: salesOrgId, teamId: salesTeamId },
    org: {
      org_id: salesOrgId,
      tenant_slug: 'sales-job-test',
      org_role: 'owner',
      teams: [salesTeamId],
      team_roles: { [salesTeamId]: 'owner' },
    },
    jobAuthorization: {
      grant_handle: input.grantHandle,
      request_id: input.requestId,
      job_id: input.jobId,
      purpose: 'research_job',
      authorized_until: Math.floor(input.authorizedUntil.getTime() / 1000),
    },
  });
}

export async function teardownJobComputeFixture() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  resetAccessTokenKeyCache();
  if (cleanup) await cleanup();
}

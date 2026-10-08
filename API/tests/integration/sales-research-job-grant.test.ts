import { randomUUID } from 'node:crypto';

import { ConfidentialDelegationScope, Prisma, type PrismaClient } from '@prisma/client';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { getAccessTokenPublicJwks, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import {
  issueSalesResearchJobGrant,
  renewSalesResearchJobGrant,
  revokeSalesResearchJobGrant,
  SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH,
  SALES_RESEARCH_JOB_PRODUCT,
  SALES_RESEARCH_JOB_PURPOSE,
  SALES_RESEARCH_JOB_RESOURCE,
} from '../../src/services/sales-research-job-grant.service.js';

const enabled = Boolean(process.env.DATABASE_URL);
const sourceDomain = 'app.salesnerd.live';
const subjectId = 'sales-job-grant-subject';
const orgId = 'sales-job-grant-org';
const teamId = 'sales-job-grant-team';
const baseUrl = 'https://authentication.unlikeotherai.com';
const config = { org_features: { enabled: true, groups_enabled: false } };
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

describe.skipIf(!enabled)('SalesNerd research-job grants', () => {
  let db: PrismaClient;
  let cleanup: () => Promise<void>;
  let sourcePrivateKey: KeyLike;
  let sourcePublicJwk: JWK;
  let resourcePrivateJwk: JWK;
  let clientDomainId: string;
  let nowSeconds: number;

  beforeAll(async () => {
    const sourcePair = await generateKeyPair('RS256', { extractable: true });
    sourcePrivateKey = sourcePair.privateKey;
    sourcePublicJwk = await exportJWK(sourcePair.publicKey);
    Object.assign(sourcePublicJwk, { kid: 'sales-job-grant-source', alg: 'RS256', use: 'sig' });
    const resourcePair = await generateKeyPair('RS256', { extractable: true });
    resourcePrivateJwk = await exportJWK(resourcePair.privateKey);
    Object.assign(resourcePrivateJwk, { kid: 'sales-job-grant-resource', alg: 'RS256', use: 'sig' });

    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required');
    db = handle.prisma;
    cleanup = handle.cleanup;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.PUBLIC_BASE_URL = baseUrl;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(resourcePrivateJwk);
    resetAccessTokenKeyCache();
    nowSeconds = Math.floor(Date.now() / 1000);

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`INSERT INTO users
        (id, email, user_key, name) VALUES
        (${subjectId}, 'sales-job-grant@example.com', 'sales-job-grant@example.com', 'Grant test'),
        ('sales-job-grant-other-subject', 'other-grant@example.com', 'other-grant@example.com', 'Other')`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO organisations
        (id, domain, name, slug, owner_id, updated_at) VALUES
        (${orgId}, ${sourceDomain}, 'Grant test', 'sales-job-grant', ${subjectId}, CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO teams
        (id, org_id, name, slug, updated_at) VALUES
        (${teamId}, ${orgId}, 'Grant test', 'sales-job-grant', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO teams
        (id, org_id, name, slug, updated_at) VALUES
        ('sales-job-grant-other-team', ${orgId}, 'Other team', 'sales-job-grant-other', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO org_members
        (id, org_id, user_id, domain, role, updated_at) VALUES
        ('sales-job-grant-org-member', ${orgId}, ${subjectId}, ${sourceDomain}, 'owner', CURRENT_TIMESTAMP),
        ('sales-job-grant-other-org-member', ${orgId}, 'sales-job-grant-other-subject', ${sourceDomain}, 'member', CURRENT_TIMESTAMP)`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO team_members
        (id, team_id, user_id, team_role, updated_at) VALUES
        ('sales-job-grant-team-member', ${teamId}, ${subjectId}, 'owner', CURRENT_TIMESTAMP),
        ('sales-job-grant-other-team-member', 'sales-job-grant-other-team', ${subjectId}, 'member', CURRENT_TIMESTAMP),
        ('sales-job-grant-other-subject-team-member', ${teamId}, 'sales-job-grant-other-subject', 'member', CURRENT_TIMESTAMP)`);
      await tx.domainRole.create({ data: { domain: sourceDomain, userId: subjectId, role: 'USER' } });
      await tx.domainRole.create({ data: { domain: sourceDomain,
        userId: 'sales-job-grant-other-subject', role: 'USER' } });
    });

    const clientDomain = await db.clientDomain.create({ data: {
      domain: sourceDomain, label: 'SalesNerd', status: 'active',
    } });
    clientDomainId = clientDomain.id;
    await db.confidentialDelegationMapping.create({ data: {
      clientDomainId, product: SALES_RESEARCH_JOB_PRODUCT,
      resource: SALES_RESEARCH_JOB_RESOURCE,
      scopes: [ConfidentialDelegationScope.AI_INVOKE], enabled: true,
    } });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (cleanup) await cleanup();
  });

  function fakeConfigJwt(): string {
    const payload = Buffer.from(JSON.stringify({ domain: sourceDomain,
      jwks_url: `https://${sourceDomain}/.well-known/jwks.json` })).toString('base64url');
    return `e30.${payload}.signature-not-checked-by-the-direct-service-test`;
  }

  async function subjectToken(input: {
    requestId: string; jobId: string; jti?: string; authorizedUntil?: number;
    activeOrgId?: string; activeTeamId?: string; tokenVersion?: number; subjectId?: string;
  }): Promise<string> {
    return new SignJWT({ source_domain: sourceDomain, tv: input.tokenVersion ?? 0,
      active: { orgId: input.activeOrgId ?? orgId, teamId: input.activeTeamId ?? teamId },
      job_authorization: {
        request_id: input.requestId, job_id: input.jobId,
        product: SALES_RESEARCH_JOB_PRODUCT, resource: SALES_RESEARCH_JOB_RESOURCE,
        purpose: SALES_RESEARCH_JOB_PURPOSE,
        authorized_until: input.authorizedUntil ?? nowSeconds + 60 * 60,
      } })
      .setProtectedHeader({ alg: 'RS256', kid: 'sales-job-grant-source', typ: 'JWT' })
      .setIssuer(sourceDomain)
      .setAudience(`${baseUrl}${SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH}`)
      .setSubject(input.subjectId ?? subjectId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 45)
      .setJti(input.jti ?? randomUUID())
      .sign(sourcePrivateKey);
  }

  async function issue(requestId: string, jobId: string, overrides: {
    authorizedUntil?: number; jti?: string; activeOrgId?: string; activeTeamId?: string;
    tokenVersion?: number; subjectId?: string;
  } = {}, at = nowSeconds) {
    return issueSalesResearchJobGrant({ clientDomainId, sourceDomain,
      configJwt: fakeConfigJwt(), config, requestId,
      subjectToken: await subjectToken({ requestId, jobId, ...overrides }),
    }, {
      prisma: db, now: () => at,
      fetchJwks: async () => ({ keys: [sourcePublicJwk] }),
    });
  }

  it('recovers one exact grant and returns a short Ledger token bound to the parent job', async () => {
    const requestId = randomUUID();
    const jobId = 'j_sales_grant_parent_001';
    const authorizedUntil = nowSeconds + 3_600;
    const first = await issue(requestId, jobId, { authorizedUntil });
    expect(first.created).toBe(true);
    const replay = await issue(requestId, jobId, { authorizedUntil });
    expect(replay).toEqual({ ...first, created: false });
    expect(await db.salesResearchJobGrant.count({ where: { requestId } })).toBe(1);

    const renewed = await renewSalesResearchJobGrant({ grantHandle: first.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) });
    expect(renewed.expiresIn).toBe(120);
    const jwks = await getAccessTokenPublicJwks();
    const { payload, protectedHeader } = await jwtVerify(renewed.accessToken,
      (await import('jose')).createLocalJWKSet(jwks), {
        issuer: baseUrl, audience: SALES_RESEARCH_JOB_RESOURCE,
      });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
    expect(payload).toMatchObject({ sub: subjectId, tv: 0, product: 'salesnerd',
      scope: 'ai.invoke', source_domain: sourceDomain,
      active: { orgId, teamId },
      job_authorization: { grant_handle: first.grantHandle, request_id: requestId,
        job_id: jobId, purpose: 'research_job', authorized_until: authorizedUntil },
    });
    expect(payload.exp).toBeLessThanOrEqual(authorizedUntil);
    expect(decodeJwt(renewed.accessToken).exp).toBeLessThanOrEqual(authorizedUntil);
  });

  it('rejects altered request/job bindings and never renews after revocation', async () => {
    const requestId = randomUUID();
    const jobId = 'j_sales_grant_parent_002';
    const grant = await issue(requestId, jobId);
    await expect(issue(requestId, `${jobId}-changed`)).rejects.toThrow('JOB_GRANT_REQUEST_CONFLICT');
    await expect(renewSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId: `${jobId}-changed` },
    { prisma: db, now: new Date(nowSeconds * 1000) })).rejects.toThrow('JOB_GRANT_UNAVAILABLE');
    expect(await revokeSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) })).toEqual({ revoked: true });
    expect(await revokeSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) })).toEqual({ revoked: true });
    await expect(renewSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) })).rejects.toThrow('JOB_GRANT_UNAVAILABLE');
    await db.teamMember.update({ where: { id: 'sales-job-grant-team-member' }, data: { status: 'ACTIVE' } });
  });

  it('checks the live credential epoch and exact active team on every renewal', async () => {
    const requestId = randomUUID();
    const jobId = 'j_sales_grant_parent_003';
    const grant = await issue(requestId, jobId);
    await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 1 } });
    await expect(renewSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) })).rejects.toThrow('JOB_GRANT_UNAVAILABLE');
    await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 0 } });
    await db.teamMember.update({ where: { id: 'sales-job-grant-team-member' }, data: { status: 'REMOVED' } });
    await expect(renewSalesResearchJobGrant({ grantHandle: grant.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) })).rejects.toThrow('JOB_GRANT_UNAVAILABLE');
    await db.teamMember.update({ where: { id: 'sales-job-grant-team-member' }, data: { status: 'ACTIVE' } });
  });

  it('creates a fresh same-owner generation after revocation or epoch change and rejects lineage takeover', async () => {
    const jobId = 'j_sales_grant_generation_001';
    const originalRequestId = randomUUID();
    const original = await issue(originalRequestId, jobId);
    await revokeSalesResearchJobGrant({ grantHandle: original.grantHandle,
      clientDomainId, sourceDomain, requestId: originalRequestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) });
    const originalRow = await db.salesResearchJobGrant.findUniqueOrThrow({
      where: { id: original.grantHandle },
    });

    await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 1 } });
    try {
      const nextRequestId = randomUUID();
      const next = await issue(nextRequestId, jobId, { tokenVersion: 1 });
      expect(next.created).toBe(true);
      expect(next.grantHandle).not.toBe(original.grantHandle);
      const unchanged = await db.salesResearchJobGrant.findUniqueOrThrow({
        where: { id: original.grantHandle },
      });
      expect(unchanged).toEqual(originalRow);

      await expect(issue(randomUUID(), jobId, {
        tokenVersion: 1, activeTeamId: 'sales-job-grant-other-team',
      })).rejects.toThrow('JOB_GRANT_REQUEST_CONFLICT');
      await expect(issue(randomUUID(), jobId, {
        subjectId: 'sales-job-grant-other-subject',
      })).rejects.toThrow('JOB_GRANT_REQUEST_CONFLICT');
    } finally {
      await db.user.update({ where: { id: subjectId }, data: { tokenVersion: 0 } });
    }

    const expiringJobId = 'j_sales_grant_generation_expiry_001';
    const expiring = await issue(randomUUID(), expiringJobId, {
      authorizedUntil: nowSeconds + 1,
    });
    const recovered = await issue(randomUUID(), expiringJobId, {}, nowSeconds + 2);
    expect(recovered.created).toBe(true);
    expect(recovered.grantHandle).not.toBe(expiring.grantHandle);
  });

  it('serializes simultaneous exact issuance and does not enlarge the signed expiry', async () => {
    await db.teamMember.update({ where: { id: 'sales-job-grant-team-member' }, data: { status: 'ACTIVE' } });
    const requestId = randomUUID();
    const jobId = 'j_sales_grant_parent_004';
    const authorizedUntil = nowSeconds + 70;
    const [left, right] = await Promise.all([
      issue(requestId, jobId, { authorizedUntil }), issue(requestId, jobId, { authorizedUntil }),
    ]);
    expect(left.grantHandle).toBe(right.grantHandle);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    const renewed = await renewSalesResearchJobGrant({ grantHandle: left.grantHandle,
      clientDomainId, sourceDomain, config, requestId, jobId },
    { prisma: db, now: new Date(nowSeconds * 1000) });
    expect(renewed.expiresIn).toBe(70);
  });
});

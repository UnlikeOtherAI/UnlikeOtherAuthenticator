import { recordIndependentAuthentication } from '../../src/services/authentication-evidence.service.js';
import { createManagementIntent, finishManagementIntent } from '../../src/services/org-sso-management-intent.service.js';
import { exchangeManagementContinuation, managementSession } from '../../src/services/org-sso-management.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { resolveTokenFamilyAssurance } from '../../src/services/token-assurance.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { asPrismaClient } from '../../src/db/tenant-context.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { issueSessionAssurance, validateSessionAssurance } from '../../src/services/session-assurance.service.js';
import { revokeEnterpriseScope, lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';

describe('enterprise scoped authority transactions with real PostgreSQL', () => {
  let handle: RlsTestDbHandle;
  let app: PrismaClient;
  const userId = `sso-user-${randomUUID()}`;
  const domain = `sso-${randomUUID()}.example.com`;
  const orgA = `sso-org-a-${randomUUID()}`;
  const orgB = `sso-org-b-${randomUUID()}`;
  const now = new Date();
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
  const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const created = await createRlsTestDb();
    if (!created) throw new Error('DATABASE_URL must name a real isolated PostgreSQL test database');
    handle = created;
    app = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    await app.$connect();
    await handle.prisma.clientDomain.create({ data: { domain, label: 'SSO test' } });
    await handle.prisma.user.create({ data: { id: userId, email: `${userId}@example.com`, userKey: userId } });
    for (const id of [orgA, orgB]) {
      await handle.prisma.organisation.create({ data: { id, domain, name: id, slug: id, ownerId: userId } });
      await handle.prisma.orgMember.create({ data: { orgId: id, userId, role: 'owner' } });
      await handle.prisma.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: id } });
      await handle.prisma.refreshToken.create({ data: { tokenHash: `hash-${id}`, familyId: `family-${id}`,
        userId, domain, clientId: 'client', configUrl: `https://${domain}/config`, orgId: id,
        expiresAt: new Date(now.getTime() + 3600000) } });
    }
  });
  afterAll(async () => { await app?.$disconnect(); await handle?.cleanup();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });

  it('preserves two active memberships on the same origin', async () => {
    const memberships = await handle.prisma.orgMember.findMany({ where: { userId, status: 'ACTIVE' } });
    expect(memberships.map((m) => m.orgId).sort()).toEqual([orgA, orgB].sort());
  });
  it('rejects connection scope substitution structurally', async () => {
    const connection = await handle.prisma.orgSsoConnection.create({ data: {
      clientDomain: domain, orgId: orgA, protocol: 'oidc', preset: 'other_oidc', displayName: 'Provider', configuration: {},
    } });
    await expect(handle.prisma.externalIdentity.create({ data: { connectionId: connection.id,
      clientDomain: domain, orgId: orgB, userId, issuer: 'https://idp.example.com', tenant: 'tenant',
      subject: 'stable', identityScope: 'global', linkedVia: 'independent_session' } })).rejects.toThrow();
  });
  it('atomically rolls back revocation and outbox if authority mutation fails', async () => {
    await expect(handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await revokeEnterpriseScope({ clientDomain: domain, orgId: orgA, scope: 'product_org', revision: 2 }, tx);
      throw new Error('rollback proof');
    })).rejects.toThrow('rollback proof');
    expect(await handle.prisma.orgRevocationEvent.count({ where: { clientDomain: domain } })).toBe(0);
    expect((await handle.prisma.refreshToken.findFirstOrThrow({ where: { familyId: `family-${orgA}` } })).revokedAt).toBeNull();
  });
  it('revokes exact-org assurance/family without global epoch or sibling logout', async () => {
    const issued = await handle.prisma.$transaction((tx) => issueSessionAssurance({
      userId, credentialEpoch: 0, clientDomain: domain, orgId: orgA, teamId: null,
      familyId: `family-${orgA}`, method: 'independent', observedAt: now, authenticatedAt: now,
      mfaSource: 'none', amr: ['pwd'], policyGeneration: 1, expiresAt: new Date(now.getTime() + 1800000),
    }, tx));
    await validateSessionAssurance({ reference: issued.reference, userId, credentialEpoch: 0,
      clientDomain: domain, orgId: orgA }, handle.prisma);
    await handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      return revokeEnterpriseScope({ clientDomain: domain, orgId: orgA, scope: 'product_org', revision: 2 }, tx);
    });
    await expect(validateSessionAssurance({ reference: issued.reference, userId, credentialEpoch: 0,
      clientDomain: domain, orgId: orgA }, handle.prisma)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
    expect((await handle.prisma.refreshToken.findFirstOrThrow({ where: { familyId: `family-${orgB}` } })).revokedAt).toBeNull();
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(0);
    expect(await handle.prisma.orgRevocationEvent.count({ where: { clientDomain: domain, orgId: orgA } })).toBe(1);
  });
  it('serializes event allocation through commit before a competing authority write', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { acquired = resolve; });
    const first = handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      const event = await tx.orgRevocationEvent.create({ data: { clientDomain: domain,
        orgId: orgA, scope: 'product_org', revision: 10 } });
      acquired();
      await blocked;
      return event;
    });
    await entered;
    let secondEntered = false;
    const second = handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      secondEntered = true;
      return tx.orgRevocationEvent.create({ data: { clientDomain: domain,
        orgId: orgA, scope: 'product_org', revision: 11 } });
    });
    try {
      await handle.prisma.$executeRaw`SELECT pg_sleep(0.1)`;
      expect(secondEntered).toBe(false);
    } finally { release(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.sequence < b.sequence).toBe(true);
  });
  it('finishes owner management from fresh evidence without issuing a product family or code', async () => {
    const config = { domain } as ClientConfig;
    const browser = 'independent-test-browser';
    const [families, codes, proofs] = await Promise.all([handle.prisma.refreshToken.count(),
      handle.prisma.authorizationCode.count(), handle.prisma.sessionAssurance.count()]);
    const result = await handle.prisma.$transaction(async (tx) => {
      const evidence = await recordIndependentAuthentication({ userId, credentialEpoch: 0, method: 'email_password',
        config, configUrl: `https://${domain}/config`, redirectUrl: `https://${domain}/callback` }, tx);
      const intent = await createManagementIntent({ userId, credentialEpoch: 0, clientDomain: domain,
        orgId: orgB, authenticationEvidenceId: evidence, browser }, tx);
      return finishManagementIntent({ id: intent.id, userId, credentialEpoch: 0, clientDomain: domain,
        authenticationEvidenceId: evidence, twoFaCompleted: false }, tx);
    });
    const token = new URL(result.redirectTo).hash.slice('#continuation='.length);
    await expect(exchangeManagementContinuation(token, 'other-browser', handle.prisma)).rejects.toThrow('SSO_MANAGEMENT_REAUTH_REQUIRED');
    const exchanged = await exchangeManagementContinuation(token, browser, handle.prisma);
    const session = await managementSession(exchanged.browser, undefined, false, handle.prisma);
    expect(session.orgId).toBe(orgB);
    await expect(exchangeManagementContinuation(token, browser, handle.prisma)).rejects.toThrow('SSO_MANAGEMENT_REAUTH_REQUIRED');
    expect(await handle.prisma.refreshToken.count()).toBe(families);
    expect(await handle.prisma.authorizationCode.count()).toBe(codes);
    expect(await handle.prisma.sessionAssurance.count()).toBe(proofs);
  });
  it('cannot complete an owner management intent before the personal final factor', async () => {
    await handle.prisma.user.update({ where: { id: userId }, data: { twoFaEnabled: true } });
    const evidence = await recordIndependentAuthentication({ userId, credentialEpoch: 0, method: 'email_password',
      config: { domain } as ClientConfig, configUrl: `https://${domain}/config`, redirectUrl: `https://${domain}/callback` }, handle.prisma);
    const intent = await handle.prisma.$transaction((tx) => createManagementIntent({ userId, credentialEpoch: 0,
      clientDomain: domain, orgId: orgB, authenticationEvidenceId: evidence, browser: 'factor-browser' }, tx));
    await expect(handle.prisma.$transaction((tx) => finishManagementIntent({ id: intent.id, userId, credentialEpoch: 0,
      clientDomain: domain, authenticationEvidenceId: evidence, twoFaCompleted: false }, tx))).rejects.toThrow('SSO_MANAGEMENT_REAUTH_REQUIRED');
    expect((await handle.prisma.orgSsoManagementIntent.findUniqueOrThrow({ where: { id: intent.id } })).consumedAt).toBeNull();
    await handle.prisma.authenticationEvidence.update({ where: { id: evidence }, data: { mfaCompletedAt: new Date() } });
    await expect(handle.prisma.$transaction((tx) => finishManagementIntent({ id: intent.id, userId, credentialEpoch: 0,
      clientDomain: domain, authenticationEvidenceId: evidence, twoFaCompleted: true }, tx))).resolves.toHaveProperty('status', 'management');
    await expect(handle.prisma.authenticationEvidence.update({ where: { id: evidence }, data: { observedAt: new Date() } }))
      .rejects.toThrow('authentication evidence is immutable');
    await handle.prisma.user.update({ where: { id: userId }, data: { twoFaEnabled: false } });
  });
  it('derives family proof from original evidence time and consumes the evidence only once', async () => {
    await handle.prisma.enterpriseProductReadiness.upsert({ where: { clientDomain: domain },
      create: { clientDomain: domain, minimumAssuranceVersion: 1 }, update: { minimumAssuranceVersion: 1 } });
    const original = new Date(Date.now() - 300000);
    const evidence = await handle.prisma.authenticationEvidence.create({ data: { userId, credentialEpoch: 0,
      clientDomain: domain, referenceHash: randomBytes(32).toString('hex'), method: 'email_password', provenance: 'independent',
      purpose: 'authorize', actionBinding: 'verified-code-binding', observedAt: original, authenticatedAt: original,
      signatureCompletedAt: new Date(), expiresAt: new Date(Date.now() + 600000) } });
    const raw = randomUUID(); const secret = 'bounded-test-only-hash-key';
    const family = await handle.prisma.refreshToken.create({ data: { tokenHash: hashRefreshToken(raw, secret),
      familyId: randomUUID(), userId, domain, clientId: 'client', configUrl: `https://${domain}/config`, orgId: orgB,
      expiresAt: new Date(Date.now() + 3600000) } });
    const resolved = await handle.prisma.$transaction((tx) => resolveTokenFamilyAssurance({ prisma: asPrismaClient(tx),
      userId, domain, credentialEpoch: 0, refreshToken: raw, sharedSecret: secret, authenticationEvidenceId: evidence.id }));
    const proof = await handle.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: resolved.assuranceId } });
    expect(proof.observedAt).toEqual(original); expect(proof.authenticatedAt).toEqual(original);
    expect((await handle.prisma.authenticationEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).consumedAt).not.toBeNull();
    expect(proof.familyId).toBe(family.familyId);
  });
  it('makes the server assurance minimum monotonic', async () => {
    await handle.prisma.enterpriseProductReadiness.upsert({ where: { clientDomain: domain }, create: { clientDomain: domain, minimumAssuranceVersion: 1 }, update: {} });
    await expect(handle.prisma.enterpriseProductReadiness.update({ where: { clientDomain: domain },
      data: { minimumAssuranceVersion: 0 } })).rejects.toThrow('cannot downgrade');
  });
  it('denies tenant SQL access to backend custody and foreign-product policy', async () => {
    expect(await app.sessionAssurance.findMany()).toEqual([]);
    const policies = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.domain', ${domain}, true)`;
      return tx.orgSsoPolicy.findMany();
    });
    expect(policies).toHaveLength(2);
    const foreign = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.domain', 'other.example.com', true)`;
      return tx.orgSsoPolicy.findMany();
    });
    expect(foreign).toEqual([]);
  });
});

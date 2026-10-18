import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { registerRevocationConsumer, acknowledgeRevocationConsumer, revocationReadinessProof } from '../../src/services/org-sso-delivery.service.js';
import { enterpriseRevocationReady, EnterpriseRevocationCapabilities } from '../../src/services/enterprise-revocation-readiness.service.js';
import { enterpriseReadiness } from '../../src/services/org-sso-policy.service.js';
import { setOwnerScimState, issueOwnerScimToken } from '../../src/services/enterprise-scim-management.service.js';
import { authenticateScim } from '../../src/services/enterprise-scim.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';
import { setRecoveryContacts } from '../../src/services/enterprise-recovery-policy.service.js';
import { startRecoveryChallenge, completeRecoveryChallenge } from '../../src/services/enterprise-recovery-action.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { generateTotpSecret } from '../../src/services/totp.service.js';
import { TEST_SHARED_SECRET } from '../helpers/test-config.js';
import { computeTotp } from '../helpers/totp.js';
import type { managementSession } from '../../src/services/org-sso-management.service.js';

import { registerAdminEnterpriseRevocationRoutes } from '../../src/routes/internal/admin/enterprise-revocations.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { getAdminAuthDomain, getAuthServiceIdentifier, getEnv } from '../../src/config/env.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('actual consumer capability acknowledgment with real PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let connection: string;
  let registration: Awaited<ReturnType<typeof registerRevocationConsumer>>;
  const suffix = randomUUID(); const domain = `consumer-${suffix}.example.com`; const owner = `owner-${suffix}`; const org = `org-${suffix}`;
  const session = { userId: owner, orgId: org, clientDomain: domain } as Awaited<ReturnType<typeof managementSession>>;
  const capabilities = { version: 1, feed: true, reconciliation: true, use_time_assurance: true, immutable_custody: true } as const;
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for capability ACK coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'Consumer' } });
    await db.user.create({ data: { id: owner, userKey: owner, email: `${owner}@example.com` } });
    await db.organisation.create({ data: { id: org, domain, ownerId: owner, name: 'Consumer', slug: org } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org, arrangementEnabled: true } });
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1,
      authorityMigrationRevision: 'audited', revocationConsumersRevision: 'audited' } });
    connection = (await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: org, protocol: 'oidc', preset: 'other_oidc',
      displayName: 'Connection', configuration: {} } })).id;
    registration = await registerRevocationConsumer({ client_domain: domain, key_id: 'key-1', destination: `https://${domain}/revocations` });
  }, 120000);
  afterAll(async () => {
    stores.db = null; await db?.$disconnect(); await handle?.cleanup();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  it('prepares strict proof issuance through the authenticated operator route without attesting consumer readiness', async () => {
    const adminDomain = getAdminAuthDomain();
    await db.domainRole.create({ data: { domain: adminDomain, userId: owner, role: 'SUPERUSER' } });
    const token = await new SignJWT({ email: `${owner}@example.com`, domain: adminDomain, client_id: 'operator', role: 'superuser', tv: 0 })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(owner).setIssuer(getAuthServiceIdentifier())
      .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(getEnv().ADMIN_ACCESS_TOKEN_SECRET));
    const app = Fastify(); registerErrorHandler(app); registerAdminEnterpriseRevocationRoutes(app);
    const url = `/internal/admin/enterprise/products/${domain}`;
    const headers = { authorization: `Bearer ${token}` };
    const payload = { minimum_assurance_version: 1, authority_migration_revision: null, revocation_consumers_revision: null,
      login_entry_url: `https://${domain}/login`, config_url: `https://${domain}/config` };
    try {
      expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(200);
      expect(await db.enterpriseProductReadiness.findUniqueOrThrow({ where: { clientDomain: domain } })).toMatchObject({
        minimumAssuranceVersion: 1, authorityMigrationRevision: null, revocationConsumersRevision: null });
      const readiness = await enterpriseReadiness(domain, db, org);
      expect(readiness.activation_allowed).toBe(false); expect(readiness.enforcement_allowed).toBe(false);
      expect(readiness.blockers).toContain('NESSIE_AUTHORITY_MIGRATION_REQUIRED');
      expect(readiness.blockers).toContain('REVOCATION_CONSUMERS_REQUIRED');
      expect((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, minimum_assurance_version: 0 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, config_url: 'https://foreign.example.com/config' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: '/internal/admin/enterprise/products/missing.example.com', headers,
        payload: { ...payload, config_url: 'https://missing.example.com/config' } })).statusCode).toBe(404);
      await db.domainRole.update({ where: { domain_userId: { domain: adminDomain, userId: owner } }, data: { role: 'USER' } });
      expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(403);
    } finally {
      await app.close();
      await db.enterpriseProductReadiness.update({ where: { clientDomain: domain }, data: {
        authorityMigrationRevision: 'audited', revocationConsumersRevision: 'audited' } });
    }
  });
  it('refuses operator revision strings as a substitute for actual strict receiver capability acknowledgment', async () => {
    expect(await enterpriseRevocationReady(domain, db)).toBe(false);
    expect((await enterpriseReadiness(domain, db)).blockers).toContain('REVOCATION_CONSUMERS_REQUIRED');
    expect(() => EnterpriseRevocationCapabilities.parse({ ...capabilities, reconciliation: false })).toThrow();
    expect(() => EnterpriseRevocationCapabilities.parse({ ...capabilities, unknown: true })).toThrow();
    await expect(db.$transaction(async (tx) => { await lockEnterpriseOutbox(tx); return setOwnerScimState(session, connection, 1, true, tx); })).rejects.toThrow('SSO_ACTIVATION_NOT_READY');
  });
  it('requires secret possession and exact four capabilities before enabling transport', async () => {
    await expect(acknowledgeRevocationConsumer(domain, { key_id: 'key-1', challenge: registration.challenge,
      proof: '0'.repeat(64), capabilities })).rejects.toThrow('REVOCATION_READINESS_INVALID');
    expect(await enterpriseRevocationReady(domain, db)).toBe(false);
    await acknowledgeRevocationConsumer(domain, { key_id: 'key-1', challenge: registration.challenge, capabilities,
      proof: revocationReadinessProof(registration.secret, domain, 'key-1', registration.challenge) });
    expect(await enterpriseRevocationReady(domain, db)).toBe(true);
    expect(await enterpriseRevocationReady('foreign.example.com', db)).toBe(false);
  });
  it('permits only an attested custom scope and requires two independently confirmed recovery drills for enforcement', async () => {
    const contact = `custodian-${suffix}`;
    const factors = new Map([[owner, generateTotpSecret()], [contact, generateTotpSecret()]]);
    await db.user.update({ where: { id: owner }, data: { twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret: factors.get(owner)!, sharedSecret: TEST_SHARED_SECRET }) } });
    await db.user.create({ data: { id: contact, userKey: contact, email: `${contact}@example.com`, twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret: factors.get(contact)!, sharedSecret: TEST_SHARED_SECRET }) } });
    await db.orgMember.createMany({ data: [owner, contact].map(userId => ({ orgId: org, userId, role: userId === owner ? 'owner' : 'member' })) });
    const configured = await db.$transaction(async tx => {
      await lockEnterpriseOutbox(tx); return setRecoveryContacts(session, 1, [owner, contact], tx);
    });
    expect(await enterpriseReadiness(domain, db, org)).toMatchObject({ activation_allowed: true, enforcement_allowed: false });
    vi.useFakeTimers({ toFake: ['Date'] }); const baseline = Date.now();
    try {
      for (const purpose of ['confirm', 'drill'] as const) {
        vi.setSystemTime(baseline + (purpose === 'drill' ? 30000 : 0));
        for (const invitation of configured.invitations) {
          const handle = new URLSearchParams(new URL(invitation.recovery_url).hash.slice(1)).get('contact')!;
          const browser = `readiness-${invitation.user_id}`;
          const challenge = await startRecoveryChallenge({ contact: handle, purpose, browser });
          await completeRecoveryChallenge({ challenge: challenge.challenge, browser,
            code: computeTotp({ secret: factors.get(invitation.user_id)!, nowMs: Date.now() }) });
        }
        expect(await enterpriseReadiness(domain, db, org)).toMatchObject({ activation_allowed: true,
          enforcement_allowed: purpose === 'drill' });
      }
      await db.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: domain, orgId: org } }, data: { arrangementEnabled: false } });
      expect(await enterpriseReadiness(domain, db, org)).toMatchObject({ activation_allowed: false, enforcement_allowed: false });
      await db.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: domain, orgId: org } }, data: { arrangementEnabled: true } });
      expect((await enterpriseReadiness(domain, db, 'another-org')).activation_allowed).toBe(false);
      await db.user.update({ where: { id: contact }, data: { tokenVersion: { increment: 1 } } });
      expect(await enterpriseReadiness(domain, db, org)).toMatchObject({ activation_allowed: true, enforcement_allowed: false });
    } finally { vi.useRealTimers(); }
  });
  it('resets capability acknowledgment during rotation without blocking already-authorized deprovisioning', async () => {
    await db.$transaction(async (tx) => { await lockEnterpriseOutbox(tx); await setOwnerScimState(session, connection, 1, true, tx); });
    const token = await db.$transaction((tx) => issueOwnerScimToken(session, connection, tx));
    for (const field of ['authorityMigrationRevision', 'revocationConsumersRevision'] as const) {
      await db.enterpriseProductReadiness.update({ where: { clientDomain: domain }, data: { [field]: null } });
      await expect(db.$transaction((tx) => issueOwnerScimToken(session, connection, tx))).rejects.toThrow('SSO_ACTIVATION_NOT_READY');
      await expect(authenticateScim(connection, `Bearer ${token.token}`, db)).rejects.toThrow('UNAUTHORIZED');
      await db.enterpriseProductReadiness.update({ where: { clientDomain: domain }, data: { [field]: 'audited' } });
    }
    await registerRevocationConsumer({ client_domain: domain, key_id: 'key-2', destination: `https://${domain}/revocations` });
    expect(await enterpriseRevocationReady(domain, db)).toBe(false);
    expect((await db.orgRevocationConsumer.findUniqueOrThrow({ where: { clientDomain: domain } })).capabilityVersion).toBe(0);
    await expect(db.$transaction((tx) => issueOwnerScimToken(session, connection, tx))).rejects.toThrow('SSO_ACTIVATION_NOT_READY');
    expect((await authenticateScim(connection, `Bearer ${token.token}`, db)).connectionId).toBe(connection);
  });
});

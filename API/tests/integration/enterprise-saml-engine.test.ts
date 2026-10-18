import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient, type OrgSsoConnection } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { signedSamlResponse } from '../helpers/enterprise-saml-provider.js';
import { createEnterpriseSpKey } from '../../src/services/org-sso-sp-key.service.js';
import { enterpriseSamlKeySet } from '../../src/services/enterprise-saml-keys.service.js';
import { enterpriseSamlAuthorize, validateEnterpriseSamlCallback } from '../../src/services/org-sso-saml.service.js';
import { openEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { getPublicBaseUrl } from '../../src/config/env.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('real signed and encrypted enterprise SAML engine', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let connection: OrgSsoConnection;
  let idpKey: { private_key: string; certificate: string };
  const suffix = randomUUID(); const domain = `saml-${suffix}.example.com`; const owner = `owner-${suffix}`; const org = `org-${suffix}`;
  const id = `connection-${suffix}`; const issuer = 'https://idp.example.com/exact-tenant';
  const audience = `${getPublicBaseUrl()}/sso/saml/${id}`; const acs = `${audience}/acs`;
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  async function flow() {
    const row = await db.orgSsoFlow.create({ data: { id: randomBytes(32).toString('base64url'), connectionId: id,
      revision: connection.revision, browserHash: 'bound-browser', nonce: 'nonce', encryptedVerifier: 'unused-by-saml',
      mode: 'test', context: {}, expiresAt: new Date(Date.now() + 300000) } });
    const target = await db.$transaction((tx) => enterpriseSamlAuthorize(connection, row, tx));
    expect(new URL(target).searchParams.get('RelayState')).toBe(row.id);
    return row.id;
  }
  const response = async (flowId: string, options: Partial<Parameters<typeof signedSamlResponse>[0]> = {}) =>
    signedSamlResponse({ flowId, acs, audience, issuer, key: idpKey, ...options });
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for real SAML engine coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'SAML' } });
    await db.user.create({ data: { id: owner, userKey: owner, email: `${owner}@example.com` } });
    await db.organisation.create({ data: { id: org, domain, ownerId: owner, name: 'SAML', slug: org } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org } });
    const idp = await createEnterpriseSpKey('idp-fixture');
    idpKey = JSON.parse(await openEnterpriseSecret(idp.encryptedSecret, 'connection:idp-fixture')) as typeof idpKey;
    const sp = await createEnterpriseSpKey(id);
    connection = await db.orgSsoConnection.create({ data: { id, clientDomain: domain, orgId: org, preset: 'other_saml', protocol: 'saml',
      displayName: 'SAML', encryptedSecret: sp.encryptedSecret, publicSigningCertificates: [sp.publicCertificate], configuration: {
        entity_id: issuer, sso_url: 'https://idp.example.com/sso', certificates: [idp.publicCertificate],
        tenant: { attribute: 'tenant', value: 'exact-tenant' }, email_attribute: 'email', trusted_origins: ['https://idp.example.com'],
      } } });
  }, 120000);
  afterAll(async () => {
    stores.db = null; await db?.$disconnect(); await handle?.cleanup();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  it('validates both actual signatures, stable subject/tenant and original authentication time without creating people', async () => {
    const flowId = await flow(); const encoded = await response(flowId);
    const identity = await validateEnterpriseSamlCallback(connection, encoded, flowId);
    expect(identity).toMatchObject({ issuer, tenant: 'exact-tenant', subject: 'stable-subject', emailVerified: true });
    expect(identity.authenticatedAt?.getTime()).toBeLessThan(Date.now());
    await expect(validateEnterpriseSamlCallback(connection, encoded, flowId)).rejects.toThrow();
    expect(await db.user.count()).toBe(1); expect(await db.externalIdentity.count()).toBe(0);
  });
  it('rejects signature tampering, foreign audience/recipient and validly signed foreign tenant claims', async () => {
    let flowId = await flow(); let encoded = await response(flowId);
    encoded = Buffer.from(Buffer.from(encoded, 'base64').toString('utf8').replace('stable-subject', 'tampered-subject')).toString('base64');
    await expect(validateEnterpriseSamlCallback(connection, encoded, flowId)).rejects.toThrow();
    for (const options of [{ audience: 'https://foreign.example.com' }, { recipient: 'https://foreign.example.com/acs' }, { tenant: 'foreign-tenant' }]) {
      flowId = await flow(); await expect(validateEnterpriseSamlCallback(connection, await response(flowId, options), flowId)).rejects.toThrow();
    }
  });
  it('accepts encryption to a published next key only during bounded overlap and consumes the request once', async () => {
    const next = await createEnterpriseSpKey(id);
    connection = await db.orgSsoConnection.update({ where: { id }, data: { encryptedNextSecret: next.encryptedSecret,
      keyOverlapExpiresAt: new Date(Date.now() + 60000) } });
    const keys = await enterpriseSamlKeySet(connection); expect(keys).toHaveLength(2);
    const flowId = await flow(); const encoded = await response(flowId, { encryptForCertificate: keys[1].certificate });
    expect((await validateEnterpriseSamlCallback(connection, encoded, flowId)).subject).toBe('stable-subject');
    await expect(validateEnterpriseSamlCallback(connection, encoded, flowId)).rejects.toThrow();
    connection = await db.orgSsoConnection.update({ where: { id }, data: { keyOverlapExpiresAt: new Date(0) } });
    const expiredFlow = await flow();
    await expect(validateEnterpriseSamlCallback(connection, await response(expiredFlow, { encryptForCertificate: keys[1].certificate }), expiredFlow)).rejects.toThrow();
  });
  it('rejects a repeated signed assertion ID even on another correctly bound request', async () => {
    const assertionId = `_${randomUUID()}`; const first = await flow();
    await validateEnterpriseSamlCallback(connection, await response(first, { assertionId }), first);
    const second = await flow();
    await expect(validateEnterpriseSamlCallback(connection, await response(second, { assertionId }), second)).rejects.toThrow();
  });
});

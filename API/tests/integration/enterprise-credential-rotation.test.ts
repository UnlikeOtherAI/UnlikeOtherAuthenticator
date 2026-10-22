import { randomBytes, randomUUID, createPrivateKey, createPublicKey } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { saveEnterpriseConnection, type managementSession } from '../../src/services/org-sso-management.service.js';
import { rotateEnterpriseCredential, rotateEnterpriseSpKey } from '../../src/services/enterprise-credential-rotation.service.js';
import { enterpriseSamlKeySet } from '../../src/services/enterprise-saml-keys.service.js';
import { enterpriseSamlMetadata, parseBoundedSaml } from '../../src/services/org-sso-saml.service.js';
import { parseEnterpriseIdpMetadata } from '../../src/services/enterprise-saml-metadata.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';
import { openEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('metadata import and scoped credential rollover with real PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let samlId: string;
  const suffix = randomUUID(); const domain = `rotation-${suffix}.example.com`; const org = `org-${suffix}`; const owner = `owner-${suffix}`;
  const session = { userId: owner, orgId: org, clientDomain: domain } as Awaited<ReturnType<typeof managementSession>>;
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  const transaction = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async (tx) => { await lockEnterpriseOutbox(tx); return run(tx); });
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for rotation coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'Rotation' } });
    await db.user.create({ data: { id: owner, userKey: owner, email: `${owner}@example.com` } });
    await db.organisation.create({ data: { id: org, domain, ownerId: owner, name: 'Rotation', slug: org } });
    await db.orgMember.create({ data: { userId: owner, orgId: org, role: 'owner' } });
    samlId = (await transaction((tx) => saveEnterpriseConnection(session, { preset: 'other_saml', protocol: 'saml',
      display_name: 'SAML', configuration: {} }, undefined, tx))).connection.id;
  });
  afterAll(async () => {
    stores.db = null; await db?.$disconnect(); await handle?.cleanup();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  it('offers stable SP metadata before provider credentials and imports only one bounded exact IdP entity', async () => {
    const row = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } });
    expect(await enterpriseSamlMetadata(row)).toContain(`/sso/saml/${samlId}/acs`);
    const certificate = row.publicSigningCertificates[0].replace(/-----[^-]+-----|\s/g, '');
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="exact-issuer">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor></md:EntityDescriptor>`;
    expect(parseEnterpriseIdpMetadata(xml)).toMatchObject({ entity_id: 'exact-issuer', sso_url: 'https://idp.example.com/sso' });
    expect(() => parseEnterpriseIdpMetadata(`<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///private">]>${xml}`)).toThrow();
    expect(() => parseEnterpriseIdpMetadata(xml.replace('https://idp.example.com/sso', 'http://127.0.0.1/sso'))).toThrow();
    expect(() => parseEnterpriseIdpMetadata(xml.replace('</md:IDPSSODescriptor>', '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://foreign.example.com"/></md:IDPSSODescriptor>'))).toThrow();
  });
  it('keeps identity configuration locked after activation even when a later test changes its status', async () => {
    await db.orgSsoConnection.update({ where: { id: samlId }, data: { status: 'active' } });
    const activated = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } });
    expect(activated.activatedAt).not.toBeNull();
    await db.orgSsoConnection.update({ where: { id: samlId }, data: { status: 'testing' } });
    await expect(transaction((tx) => saveEnterpriseConnection(session, { preset: 'other_saml', protocol: 'saml',
      display_name: 'Changed', configuration: {}, revision: activated.revision }, samlId, tx))).rejects.toThrow('SSO_IDENTITY_MIGRATION_REQUIRED');
    await expect(db.orgSsoConnection.update({ where: { id: samlId }, data: { activatedAt: null } })).rejects.toThrow();
  });
  it('publishes both signing/encryption keys, requires tests, and retires overlap without exposing private material', async () => {
    const initial = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } });
    const prepared = await transaction((tx) => rotateEnterpriseSpKey(session, samlId, initial.revision, 'prepare', tx));
    expect(prepared.connection.sp_key_state).toBe('prepared'); expect(JSON.stringify(prepared)).not.toContain('PRIVATE KEY');
    let row = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } });
    const keys = await enterpriseSamlKeySet(row); expect(keys).toHaveLength(2);
    const doc = parseBoundedSaml(await enterpriseSamlMetadata(row));
    const descriptors = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'KeyDescriptor');
    expect(descriptors.length).toBe(4);
    await expect(transaction((tx) => rotateEnterpriseSpKey(session, samlId, row.revision, 'activate', tx))).rejects.toThrow('SSO_ROTATION_TEST_REQUIRED');
    await db.orgSsoConnection.update({ where: { id: samlId }, data: { testedRevision: row.revision } });
    await transaction((tx) => rotateEnterpriseSpKey(session, samlId, row.revision, 'activate', tx));
    row = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } });
    const active = await enterpriseSamlKeySet(row);
    expect(active[0].certificate).toBe(keys[1].certificate); expect(active[1].certificate).toBe(keys[0].certificate);
    expect(createPublicKey(createPrivateKey(active[0].private_key)).export({ type: 'spki', format: 'pem' })).toBe(
      createPublicKey(active[0].certificate).export({ type: 'spki', format: 'pem' }));
    await db.orgSsoConnection.update({ where: { id: samlId }, data: { testedRevision: row.revision } });
    await transaction((tx) => rotateEnterpriseSpKey(session, samlId, row.revision, 'retire', tx));
    expect(await enterpriseSamlKeySet(await db.orgSsoConnection.findUniqueOrThrow({ where: { id: samlId } }))).toHaveLength(1);
  });
  it('rotates only exact connection secrets and revokes prior proof generation', async () => {
    const row = await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: org, protocol: 'oidc', preset: 'other_oidc',
      displayName: 'OIDC', configuration: { issuer: 'unchanged' } } });
    const result = await transaction((tx) => rotateEnterpriseCredential(session, row.id, { revision: row.revision, secret: 'new-sensitive-secret' }, tx));
    const updated = await db.orgSsoConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.configuration).toEqual(row.configuration); expect(updated.generation).toBe(row.generation + 1);
    expect(updated.encryptedSecret).not.toContain('new-sensitive-secret');
    expect(await openEnterpriseSecret(updated.encryptedSecret ?? '', `connection:${row.id}`)).toBe('new-sensitive-secret');
    expect(JSON.stringify(result)).not.toContain('new-sensitive-secret');
    expect(await db.orgRevocationEvent.count({ where: { connectionId: row.id } })).toBe(1);
  });
});

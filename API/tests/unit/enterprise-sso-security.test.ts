import { describe, expect, it, vi } from 'vitest';
import type { OrgSsoConnection, SessionAssurance } from '@prisma/client';
import { validateEnterpriseConfiguration } from '../../src/services/org-sso-configuration.service.js';
import { validateEnterpriseOidcClaims } from '../../src/services/org-sso-oidc.service.js';
import { parseBoundedSaml } from '../../src/services/org-sso-saml.service.js';
import { applyScimPatch, parseScimFilter } from '../../src/services/enterprise-scim.service.js';
import { hashAssuranceReference, validateSessionAssurance, type AssuranceDb } from '../../src/services/session-assurance.service.js';
import { normalizeEnterpriseEmailDomain } from '../../src/services/org-email-domain.service.js';
import { ensureDomainRoleForUser } from '../../src/services/domain-role.service.js';
import type { PrismaClient } from '@prisma/client';

const now = new Date('2026-10-17T12:00:00Z');
const config = { issuer: 'https://idp.example.com/realm', client_id: 'client',
  authorization_endpoint: 'https://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks', trusted_origins: ['https://idp.example.com'],
  tenant: { claim: 'tid', value: 'tenant' }, subject_claim: 'sub' };
const connection = { id: 'c1', preset: 'other_oidc', protocol: 'oidc', configuration: config } as unknown as OrgSsoConnection;
const claims = { iss: config.issuer, sub: 'stable', aud: 'client', nonce: 'nonce', tid: 'tenant',
  exp: now.getTime() / 1000 + 300, iat: now.getTime() / 1000, email: 'person@example.com', email_verified: true };

describe('enterprise protocol trust boundaries', () => {
  it('accepts multiple audiences only with the exact authorized party', () => {
    expect(validateEnterpriseOidcClaims(connection, { ...claims, aud: ['client', 'other'], azp: 'client' },
      'nonce', undefined, now).subject).toBe('stable');
    expect(() => validateEnterpriseOidcClaims(connection, { ...claims, aud: ['client', 'other'] },
      'nonce', undefined, now)).toThrow();
  });
  it('never lets caller trusted_origins authorize a foreign secret endpoint', () => {
    expect(() => validateEnterpriseConfiguration('other_oidc', 'oidc', { ...config,
      token_endpoint: 'https://attacker.example.com/token', trusted_origins: ['https://idp.example.com', 'https://attacker.example.com'] }))
      .toThrow('SSO_ENDPOINT_NOT_TRUSTED');
  });
  it.each([{ nonce: 'other' }, { tid: 'other' }, { iss: 'https://other.example.com' },
    { aud: ['client', 'attacker'] }, { azp: 'other' }, { sub: '' }])('refuses invalid signed claim binding %j', (override) => {
    expect(() => validateEnterpriseOidcClaims(connection, { ...claims, ...override }, 'nonce', undefined, now)).toThrow();
  });
  it('preserves observed time separately and never invents provider auth_time', () => {
    const identity = validateEnterpriseOidcClaims(connection, claims, 'nonce', undefined, now);
    expect(identity.subject).toBe('stable'); expect(identity.authenticatedAt).toBeNull(); expect(identity.observedAt).toEqual(now);
  });
  it('validates present at_hash while allowing its absence in code flow', () => {
    expect(() => validateEnterpriseOidcClaims(connection, { ...claims, at_hash: 'fake' }, 'nonce', 'access', now)).toThrow();
    expect(validateEnterpriseOidcClaims(connection, claims, 'nonce', undefined, now).subject).toBe('stable');
  });
  it('requires auth_time when max_age is requested', () => {
    const force = { ...connection, configuration: { ...config, max_age: 0 } } as unknown as OrgSsoConnection;
    expect(() => validateEnterpriseOidcClaims(force, claims, 'nonce', undefined, now)).toThrow('SSO_AUTH_TIME_REQUIRED');
  });
  it.each(['<!DOCTYPE x [<!ENTITY bad SYSTEM "file:///etc/passwd">]><x/>',
    '<x><a ID="same"/><b ID="same"/></x>',
    '<x xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/></x>'])
  ('refuses unsafe SAML structures before signature processing', (xml) => expect(() => parseBoundedSaml(xml)).toThrow());
  it.each(['com', 'co.uk', 'gmail.com', '*.example.com', 'person@example.com'])('refuses public or malformed domain %s',
    (domain) => expect(() => normalizeEnterpriseEmailDomain(domain)).toThrow());
  it('canonicalizes IDNA without conflating subdomains', () => {
    expect(normalizeEnterpriseEmailDomain('TÉST.example.com.')).toBe('xn--tst-bma.example.com');
  });
});

describe('SCIM dialect safety', () => {
  it('supports exact Entra externalId and Okta userName filters without global lookup syntax', () => {
    expect(parseScimFilter('externalId eq "immutable-id"')).toEqual({ key: 'externalId', value: 'immutable-id' });
    expect(parseScimFilter('userName eq "person@example.com"')?.key).toBe('userName');
    expect(() => parseScimFilter('userName co "person" or active eq true')).toThrow('SCIM_INVALID_FILTER');
  });
  it('accepts standard active=false without touching canonical user data', () => {
    const result = applyScimPatch({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'person@example.com', active: true },
      { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: false }] });
    expect(result.active).toBe(false); expect(result.userName).toBe('person@example.com');
  });
  it('refuses password, owner and arbitrary immutable-field patches', () => {
    for (const path of ['password', 'roles', 'id', 'owner']) expect(() => applyScimPatch({ schemas: [] },
      { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path, value: 'x' }] })).toThrow();
  });
});

describe('opaque assurance and lineage', () => {
  it('never bootstraps a first enterprise account into domain superuser', async () => {
    const store = { domainRole: { findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async (args) => args.data) } };
    const role = await ensureDomainRoleForUser({ domain: 'product.example.com', userId: 'enterprise-user',
      allowBootstrap: false, prisma: store as unknown as PrismaClient });
    expect(role.role).toBe('USER');
    expect(store.domainRole.create).toHaveBeenCalledWith({ data: { domain: 'product.example.com', userId: 'enterprise-user', role: 'USER' } });
  });
  const proof = { id: 'a1', userId: 'u1', clientDomain: 'product.example.com', credentialEpoch: 2,
    orgId: null, teamId: null, familyId: 'family1', parentId: null, method: 'independent',
    observedAt: new Date(now.getTime() - 10000), expiresAt: new Date(now.getTime() + 60000), revokedAt: null } as SessionAssurance;
  const binding = { reference: 'random-reference', userId: 'u1', clientDomain: 'product.example.com', credentialEpoch: 2 };
  function db(row: SessionAssurance = proof): AssuranceDb {
    return { sessionAssurance: { findUnique: vi.fn().mockResolvedValue(row) },
      user: { findUnique: vi.fn().mockResolvedValue({ tokenVersion: 2, lifecycleStatus: 'ACTIVE' }) },
      refreshToken: { findFirst: vi.fn().mockResolvedValue({ id: 'r1', expiresAt: new Date(now.getTime() + 3600000) }) } } as unknown as AssuranceDb;
  }
  it('looks up the hash, not raw backend custody reference', async () => {
    const store = db(); await validateSessionAssurance(binding, store, now);
    expect(store.sessionAssurance.findUnique).toHaveBeenCalledWith({ where: { referenceHash: hashAssuranceReference(binding.reference) } });
  });
  it.each([{ clientDomain: 'other.example.com' }, { userId: 'u2' }, { credentialEpoch: 3 }, { orgId: 'other-org' }])
  ('refuses same-user or epoch scope substitutions %j', async (override) => {
    await expect(validateSessionAssurance({ ...binding, ...override }, db(), now)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
  });
  it('refuses absent, expired, revoked and cyclic proof', async () => {
    await expect(validateSessionAssurance({ ...binding, reference: undefined }, db(), now)).rejects.toThrow();
    for (const override of [{ expiresAt: now }, { revokedAt: now }, { parentId: 'a1' }]) {
      await expect(validateSessionAssurance(binding, db({ ...proof, ...override }), now)).rejects.toThrow();
    }
  });
  it('does not promote recovery provenance to global account control', async () => {
    await expect(validateSessionAssurance({ ...binding, requirement: 'global_account_control' },
      db({ ...proof, method: 'recovery' }), now)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
  });
  it('refuses a source family already revoked even if the assurance has time left', async () => {
    const store = db(); vi.mocked(store.refreshToken.findFirst).mockResolvedValue(null);
    await expect(validateSessionAssurance(binding, store, now)).rejects.toThrow();
  });
  it.each([{ clientDomain: 'another.example.com' }, { orgId: 'another-org' },
    { method: 'recovery' }, { connectionId: 'another-connection' }])
  ('rejects ancestor scope or provenance substitution %j', async (override) => {
    const child = { ...proof, parentId: 'parent' };
    const parent = { ...proof, id: 'parent', ...override } as SessionAssurance;
    const store = db(child);
    vi.mocked(store.sessionAssurance.findUnique).mockResolvedValueOnce(child).mockResolvedValueOnce(parent);
    await expect(validateSessionAssurance(binding, store, now)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
  });
});

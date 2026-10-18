import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { recordIndependentAuthentication } from '../../src/services/authentication-evidence.service.js';
import { authorizeCredentialSurface, credentialRouteRegistry } from '../../src/services/credential-route-registry.service.js';
import { signLoginSession, verifyLoginSession } from '../../src/services/login-session.service.js';
import { signTwoFaChallenge, verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { signTwoFaSetupToken, verifyTwoFaSetupToken } from '../../src/services/twofactor-setup-token.service.js';
import { withEpochValidSigningContinuationRead, hashSigningContinuationToken } from '../../src/services/signing-continuation-capability.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));

describe('live credential surface authority boundaries with PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>; let db: PrismaClient;
  const originalUrl = process.env.DATABASE_URL;
  const sharedSecret = 'credential-registry-test-secret-with-enough-length'; const audience = 'registry-test';
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw new Error('DATABASE_URL required for credential route coverage');
    handle = created; db = handle.prisma; stores.db = db; process.env.DATABASE_URL = handle.databaseUrl;
  });
  afterAll(async () => {
    if (originalUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL'); else process.env.DATABASE_URL = originalUrl;
    await handle?.cleanup();
  });
  async function fixture(method = 'email_password') {
    const domain = `registry-${randomUUID()}.example.com`; const configUrl = `https://${domain}/config`;
    const redirectUrl = `https://${domain}/callback`;
    const config = validateConfigFields(baseClientConfigPayload({ domain, redirect_urls: [redirectUrl],
      org_features: { enabled: true, user_needs_team: false }, login_flow: { team_selection: 'off' } }));
    await db.clientDomain.create({ data: { domain, label: 'Registry', status: 'active' } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const id = await recordIndependentAuthentication({ userId: user.id, credentialEpoch: 0, method,
      verifiedEvent: method === 'google' ? { kind: 'provider', authenticatedAt: null } : { kind: 'local_credential' },
      config, configUrl, redirectUrl }, db);
    return { id, user, domain, config, configUrl, redirectUrl,
      input: { userId: user.id, clientDomain: domain, credentialEpoch: 0, authenticationEvidenceId: id, method } };
  }
  async function organisation(f: Awaited<ReturnType<typeof fixture>>, enforcement: 'off' | 'required_for_all_members' = 'off') {
    const org = await db.organisation.create({ data: { domain: f.domain, ownerId: f.user.id, name: 'Registry', slug: randomUUID() } });
    await db.orgMember.create({ data: { userId: f.user.id, orgId: org.id, role: 'owner' } });
    await db.orgSsoPolicy.create({ data: { clientDomain: f.domain, orgId: org.id, arrangementEnabled: true, enforcement } });
    return org;
  }

  it('never treats a signed scoped method without its proof as legacy, even below the floor', async () => {
    const f = await fixture();
    for (const surface of Object.keys(credentialRouteRegistry) as Array<keyof typeof credentialRouteRegistry>) {
      for (const method of ['sso', 'sso_recovery', 'recovery']) {
        await expect(authorizeCredentialSurface(surface, { userId: f.user.id, clientDomain: f.domain,
          credentialEpoch: 0, method }, db)).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
      }
    }
  });
  it('applies org policy only to exact org authority and preserves independent global actions', async () => {
    const f = await fixture(); const org = await organisation(f, 'required_for_all_members');
    await expect(authorizeCredentialSurface('public_access', { ...f.input, orgId: org.id }, db)).resolves.toMatchObject({ provenance: 'independent' });
    await expect(authorizeCredentialSurface('configured_authorization', { ...f.input, orgId: org.id }, db)).rejects.toThrow('SSO_TEAM_REAUTH_REQUIRED');
    await expect(authorizeCredentialSurface('public_access', { ...f.input, clientDomain: 'foreign.example.com' }, db)).rejects.toThrow();
  });
  it('keeps actual configured global access available while exact organisation access requires SSO', async () => {
    const f = await fixture(); const org = await organisation(f, 'required_for_all_members'); const familyId = randomUUID();
    await issueRefreshToken({ userId: f.user.id, domain: f.domain, clientId: 'registry', configUrl: f.configUrl,
      orgId: org.id, familyId, credentialEpoch: 0 }, { prisma: db });
    const issued = await db.$transaction(tx => issueSessionAssurance({ familyId, userId: f.user.id, clientDomain: f.domain,
      orgId: org.id, credentialEpoch: 0, method: 'independent', amr: ['email_password'], mfaSource: 'none',
      observedAt: new Date(), authenticatedAt: new Date(), policyGeneration: 1, expiresAt: new Date(Date.now() + 60000) }, tx));
    const token = await new SignJWT({ email: f.user.email, domain: f.domain, client_id: 'registry', role: 'user', tv: 0,
      assurance_id: issued.assurance.id, org: { org_id: org.id, org_role: 'owner', teams: [], team_roles: {} } })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service')
      .setAudience(ACCESS_TOKEN_AUDIENCE).setSubject(f.user.id).setExpirationTime('1m').sign(new TextEncoder().encode(sharedSecret));
    await expect(verifyAccessToken(token, { prisma: db, sharedSecret })).resolves.toMatchObject({ userId: f.user.id });
    await expect(verifyAccessToken(token, { prisma: db, sharedSecret, requirement: 'enterprise_org_access' })).rejects.toThrow('SSO_TEAM_REAUTH_REQUIRED');
  });
  it('rechecks an actual signed chooser and factor token against revoked original evidence', async () => {
    const f = await fixture();
    const login = await signLoginSession({ userId: f.user.id, credentialEpoch: 0, authMethod: 'email_password',
      authenticationEvidenceId: f.id, config: f.config, configUrl: f.configUrl, redirectUrl: f.redirectUrl,
      rememberMe: false, requestAccess: false, sharedSecret, audience });
    const challenge = await signTwoFaChallenge({ userId: f.user.id, credentialEpoch: 0, authMethod: 'email_password',
      authenticationEvidenceId: f.id, domain: f.domain, configUrl: f.configUrl, redirectUrl: f.redirectUrl, sharedSecret, audience });
    const setup = await signTwoFaSetupToken({ userId: f.user.id, credentialEpoch: 0, authMethod: 'email_password',
      authenticationEvidenceId: f.id, domain: f.domain, configUrl: f.configUrl, encryptedSecret: 'opaque', sharedSecret, audience });
    await expect(verifyLoginSession({ token: login, config: f.config, configUrl: f.configUrl, sharedSecret, audience })).resolves.toMatchObject({ authenticationEvidenceId: f.id });
    await expect(verifyTwoFaChallenge({ token: challenge, sharedSecret, audience })).resolves.toMatchObject({ authenticationEvidenceId: f.id });
    await expect(verifyTwoFaSetupToken({ token: setup, sharedSecret, audience })).resolves.toMatchObject({ authenticationEvidenceId: f.id });
    await db.authenticationEvidence.update({ where: { id: f.id }, data: { revokedAt: new Date() } });
    await expect(verifyLoginSession({ token: login, config: f.config, configUrl: f.configUrl, sharedSecret, audience })).rejects.toThrow();
    await expect(verifyTwoFaChallenge({ token: challenge, sharedSecret, audience })).rejects.toThrow();
    await expect(verifyTwoFaSetupToken({ token: setup, sharedSecret, audience })).rejects.toThrow();
  });
  it('refuses missing proof at floor one without rebasing or minting new evidence', async () => {
    const f = await fixture(); await db.enterpriseProductReadiness.create({ data: { clientDomain: f.domain, minimumAssuranceVersion: 1 } });
    const count = await db.authenticationEvidence.count({ where: { userId: f.user.id } });
    await expect(authorizeCredentialSurface('login_chooser', { userId: f.user.id, clientDomain: f.domain,
      credentialEpoch: 0, method: 'email_password' }, db)).rejects.toThrow();
    expect(await db.authenticationEvidence.count({ where: { userId: f.user.id } })).toBe(count);
  });
  it('rechecks mailbox/social proof after enrollment but accepts existing personal-factor provenance', async () => {
    const f = await fixture('google'); const org = await organisation(f);
    const connection = await db.orgSsoConnection.create({ data: { clientDomain: f.domain, orgId: org.id,
      protocol: 'oidc', preset: 'other_oidc', displayName: 'Registry', configuration: {} } });
    await db.externalIdentity.create({ data: { userId: f.user.id, clientDomain: f.domain, orgId: org.id,
      connectionId: connection.id, issuer: 'https://issuer.example.com', tenant: 'tenant', subject: randomUUID(), identityScope: 'global', linkedVia: 'independent_session' } });
    await expect(authorizeCredentialSurface('public_access', f.input, db)).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    await db.authenticationEvidence.update({ where: { id: f.id }, data: { mfaCompletedAt: new Date() } });
    await expect(authorizeCredentialSurface('public_access', f.input, db)).resolves.toMatchObject({ authenticatedAt: null });
  });
  it('protects actual signing-continuation reads before exposing documents or accepting signatures', async () => {
    const f = await fixture(); const token = randomUUID();
    await db.signingContinuation.create({ data: { userId: f.user.id, domain: f.domain, authProfile: 'CONFIG_JWT',
      tokenHash: hashSigningContinuationToken(token, sharedSecret), configUrl: f.configUrl, redirectUrl: f.redirectUrl,
      codeChallenge: '', codeChallengeMethod: 'S256', authMethod: 'email_password', tokenVersion: 0,
      authenticationEvidenceId: f.id, policyRevision: 0, expiresAt: new Date(Date.now() + 60000) } });
    const read = vi.fn(async () => 'private document');
    const deps = { prisma: db, sharedSecret };
    await expect(withEpochValidSigningContinuationRead(token, read, deps)).resolves.toBe('private document');
    await db.authenticationEvidence.update({ where: { id: f.id }, data: { revokedAt: new Date() } }); read.mockClear();
    await expect(withEpochValidSigningContinuationRead(token, read, deps)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
});

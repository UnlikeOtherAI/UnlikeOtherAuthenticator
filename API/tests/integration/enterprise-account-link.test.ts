import { enterpriseAccountLinkContext } from '../../src/services/org-sso-account-link.service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { testUiTheme, TEST_SHARED_SECRET } from '../helpers/test-config.js';
import { computeTotp } from '../helpers/totp.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { generateTotpSecret } from '../../src/services/totp.service.js';
import { sealEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { hashAssuranceReference } from '../../src/services/session-assurance.service.js';
import { fingerprintClientConfig } from '../../src/services/client-config-fingerprint.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { startEnterpriseAccountLink, startLinkPersonalFactor, verifyLinkPersonalFactor } from '../../src/services/org-sso-link-factor.service.js';
import { loginWithEmailPassword } from '../../src/services/auth-login.service.js';
import { hashPassword } from '../../src/services/password.service.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import { startTwoFactorSetup } from '../../src/services/twofactor-setup.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));

describe('existing personal factor account linking with real PostgreSQL', () => {
  let handle: RlsTestDbHandle;
  let db: PrismaClient;
  let config: ClientConfig;
  let connectionId: string;
  let secret: string;
  const suffix = randomUUID();
  const domain = `link-${suffix}.example.com`;
  const userId = `link-user-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const orgId = `link-org-${suffix}`;
  const teamId = `link-team-${suffix}`;
  const priorProvider = process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER;
  const priorRing = process.env.ENTERPRISE_SSO_KEYRING;
  beforeAll(async () => {
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: { test: randomBytes(32).toString('base64') } });
    const created = await createRlsTestDb();
    if (!created) throw new Error('DATABASE_URL required for real account-link boundaries');
    handle = created;
    db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    config = { domain, user_scope: 'global', redirect_urls: [`https://${domain}/callback`], enabled_auth_methods: ['email_password'],
      ui_theme: testUiTheme(), language_config: 'en', '2fa_enabled': false, debug_enabled: false,
      org_features: { enabled: true, allow_user_create_org: false, allow_user_create_team: false },
      login_flow: { email_code_enabled: false, team_selection: 'auto' } } as ClientConfig;
    secret = generateTotpSecret();
    await db.clientDomain.create({ data: { domain, label: 'Link test' } });
    await db.user.create({ data: { id: ownerId, userKey: ownerId, email: `${ownerId}@example.com` } });
    await db.user.create({ data: { id: userId, userKey: `${userId}@example.com`, email: `${userId}@example.com`,
      twoFaEnabled: true, twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: TEST_SHARED_SECRET }) } });
    await db.organisation.create({ data: { id: orgId, domain, name: 'Link test', slug: orgId, ownerId } });
    await db.orgMember.createMany({ data: [{ userId: ownerId, orgId, role: 'owner' }, { userId, orgId, role: 'member' }] });
    await db.team.create({ data: { id: teamId, orgId, name: 'Team', slug: teamId } });
    await db.teamMember.create({ data: { teamId, userId } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId, arrangementEnabled: true } });
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1,
      authorityMigrationRevision: 'test', revocationConsumersRevision: 'test' } });
    await db.orgRevocationConsumer.create({ data: { clientDomain: domain, destination: `https://${domain}/revocations`,
      keyId: 'fixture', encryptedSecret: 'fixture-not-used-for-delivery', enabled: true, acknowledgedAt: new Date(), capabilityVersion: 1 } });
    connectionId = (await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId,
      preset: 'other_oidc', protocol: 'oidc', displayName: 'Test', configuration: {}, status: 'active', testedRevision: 1 } })).id;
  });
  afterAll(async () => {
    stores.db = null; await db?.$disconnect(); await handle?.cleanup();
    if (priorProvider === undefined) delete process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER; else process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = priorProvider;
    if (priorRing === undefined) delete process.env.ENTERPRISE_SSO_KEYRING; else process.env.ENTERPRISE_SSO_KEYRING = priorRing;
  });
  async function pendingLink(subject: string) {
    const browser = randomBytes(32).toString('base64url');
    const flowId = randomBytes(32).toString('base64url');
    const context = { config_url: `https://${domain}/config`, config_fingerprint: fingerprintClientConfig(config), client_domain: domain,
      redirect_url: `https://${domain}/callback`, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'original-rp-state', policy_generation: 1 };
    const identity = { issuer: 'https://issuer.example.com', tenant: 'exact-tenant', subject,
      email: `${userId}@example.com`, emailVerified: true, groups: [], authenticatedAt: null,
      observedAt: new Date(), sessionExpiresAt: new Date(Date.now() + 3600000), amr: ['provider_claim'] };
    await db.orgSsoFlow.create({ data: { id: flowId, connectionId, revision: 1, mode: 'login', browserHash: hashAssuranceReference(browser),
      nonce: 'nonce', encryptedVerifier: await sealEnterpriseSecret(randomBytes(32).toString('base64url'), `flow:${flowId}`),
      context, consumedAt: new Date(), expiresAt: new Date(Date.now() + 600000) } });
    const link = await db.orgSsoLinkIntent.create({ data: { connectionId, clientDomain: domain, orgId, revision: 1, generation: 1,
      flowId, browserHash: hashAssuranceReference(browser), context,
      identity: { sealed: await sealEnterpriseSecret(JSON.stringify(identity), `link:${flowId}`) }, expiresAt: new Date(Date.now() + 600000) } });
    return { linkIntentId: link.id, browser, config, configUrl: context.config_url };
  }

  it('shows only the canonical destination to the original intent browser', async () => {
    const input = await pendingLink('context-subject');
    const result = await enterpriseAccountLinkContext(input);
    expect(result).toEqual({ ok: true, org: { id: orgId, name: 'Link test' }, client_domain: domain });
    await expect(enterpriseAccountLinkContext({ ...input, browser: 'foreign-browser' })).rejects.toThrow();
    await expect(enterpriseAccountLinkContext({ ...input, configUrl: 'https://foreign.example.com/config' })).rejects.toThrow();
    expect(await db.orgSsoLinkIntent.findUnique({ where: { id: input.linkIntentId } })).toMatchObject({ consumedAt: null });
  });
  it('gives unknown hints the same opaque response and durably bounds wrong guesses', async () => {
    const input = await pendingLink('wrong-proof');
    const unknown = await startLinkPersonalFactor({ ...input, email: 'absent@example.com' });
    const known = await startLinkPersonalFactor({ ...input, email: `${userId}@example.com` });
    expect(Object.keys(unknown)).toEqual(Object.keys(known));
    expect(known.challenge).toHaveLength(43); expect(unknown.challenge).toHaveLength(43);
    for (let i = 0; i < 7; i++) await expect(verifyLinkPersonalFactor({ ...input, challenge: known.challenge, code: 'invalid' })).rejects.toThrow('SSO_ACCOUNT_LINK_PROOF_REQUIRED');
    expect((await db.orgSsoPersonalFactorChallenge.findUniqueOrThrow({ where: { tokenHash: hashAssuranceReference(known.challenge) } })).attempts).toBe(6);
    expect(await db.externalIdentity.count({ where: { connectionId } })).toBe(0);
    const code = computeTotp({ secret, nowMs: Date.now() });
    await expect(verifyLinkPersonalFactor({ ...input, challenge: known.challenge, code })).rejects.toThrow();
  });

  it('requires the original browser and links using only an old personal factor, preserving scoped upstream provenance', async () => {
    const input = await pendingLink('proved-stable-subject');
    await expect(startLinkPersonalFactor({ ...input, browser: 'another-browser', email: `${userId}@example.com` })).rejects.toThrow();
    const started = await startLinkPersonalFactor({ ...input, email: `${userId}@example.com` });
    const code = computeTotp({ secret, nowMs: Date.now() });
    const result = await verifyLinkPersonalFactor({ ...input, challenge: started.challenge, code });
    expect(result.redirect_to).toContain(`https://${domain}/callback`);
    expect(result.redirect_to).toContain('state=original-rp-state');
    const external = await db.externalIdentity.findUniqueOrThrow({ where: { connectionId_issuer_tenant_subject: {
      connectionId, issuer: 'https://issuer.example.com', tenant: 'exact-tenant', subject: 'proved-stable-subject' } } });
    expect(external.userId).toBe(userId);
    const source = await db.authenticationEvidence.findUniqueOrThrow({ where: { id: external.proofAuthenticationEvidenceId! } });
    expect(source.method).toBe('personal_totp'); expect(source.consumedAt).not.toBeNull();
    const issued = await db.authorizationCode.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } });
    const evidence = await db.authenticationEvidence.findUniqueOrThrow({ where: { id: issued.authenticationEvidenceId! } });
    expect(evidence.provenance).toBe('sso'); expect(evidence.authenticatedAt).toBeNull();
    expect(evidence.orgId).toBe(orgId); expect(evidence.mfaCompletedAt).not.toBeNull();
    expect(await db.sessionAssurance.count({ where: { userId } })).toBe(0);
    expect(await db.domainRole.count({ where: { userId } })).toBe(0);
    await expect(startTwoFactorSetup({ userId, credentialEpoch: 0, config, configUrl: input.configUrl,
      finalize: { authMethod: 'sso', authenticationEvidenceId: evidence.id, redirectUrl: config.redirect_urls[0],
        rememberMe: false, requestAccess: false } }, { prisma: db })).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    await expect(verifyLinkPersonalFactor({ ...input, challenge: started.challenge, code })).rejects.toThrow();
  });

  it('accepts an actual existing password proof once without joining by the asserted email', async () => {
    const passwordUser = `password-${suffix}`;
    const email = `${passwordUser}@personal.example.com`;
    const password = 'isolated-test-password-value';
    await db.user.create({ data: { id: passwordUser, userKey: email, email, passwordHash: await hashPassword(password) } });
    await db.orgMember.create({ data: { orgId, userId: passwordUser, role: 'member' } });
    await db.teamMember.create({ data: { teamId, userId: passwordUser } });
    const input = await pendingLink('explicit-password-linked-subject');
    const verified = await loginWithEmailPassword({ email, password, config }, { prisma: db });
    const token = await signLoginSession({ userId: verified.userId, credentialEpoch: verified.credentialEpoch,
      authMethod: 'email_password', config, configUrl: input.configUrl, redirectUrl: config.redirect_urls[0],
      state: 'original-rp-state', codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256', rememberMe: false,
      requestAccess: false, sharedSecret: TEST_SHARED_SECRET, audience: LOGIN_SESSION_AUDIENCE },
    { prisma: db, verifiedEvent: { kind: 'local_credential' } });
    const result = await startEnterpriseAccountLink({ ...input, loginToken: token });
    expect('redirect_to' in result).toBe(true);
    const external = await db.externalIdentity.findUniqueOrThrow({ where: { connectionId_issuer_tenant_subject: {
      connectionId, issuer: 'https://issuer.example.com', tenant: 'exact-tenant', subject: 'explicit-password-linked-subject' } } });
    expect(external.userId).toBe(passwordUser);
    expect((await db.user.findUniqueOrThrow({ where: { id: passwordUser } })).email).toBe(email);
    await expect(startEnterpriseAccountLink({ ...input, loginToken: token })).rejects.toThrow();
  });
});

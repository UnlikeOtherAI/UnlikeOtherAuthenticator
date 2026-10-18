import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { baseClientConfigPayload, TEST_SHARED_SECRET } from '../helpers/test-config.js';
import { computeTotp } from '../helpers/totp.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { generateTotpSecret } from '../../src/services/totp.service.js';
import { hashAssuranceReference } from '../../src/services/session-assurance.service.js';
import { assertMailboxCredentialAdmission } from '../../src/services/credential-admission.service.js';
import { startManagementPersonalFactor, verifyManagementPersonalFactor } from '../../src/services/org-sso-management-factor.service.js';
import { exchangeManagementContinuation, managementSession } from '../../src/services/org-sso-management.service.js';

describe('existing personal factor gives only exact owner management authority with PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let app: PrismaClient;
  beforeAll(async () => {
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for management factor coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    app = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } }); await db.$connect();
  });
  afterAll(async () => { await app?.$disconnect(); await db?.$disconnect(); await handle?.cleanup(); });
  async function fixture() {
    const suffix = randomUUID(); const domain = `factor-${suffix}.example.com`; const email = `${suffix}@example.com`;
    const secret = generateTotpSecret(); const configUrl = `https://${domain}/config`;
    const config = validateConfigFields(baseClientConfigPayload({ domain, redirect_urls: [`https://${domain}/callback`],
      user_scope: 'global', '2fa_enabled': false, org_features: { enabled: true, user_needs_team: false } }));
    await db.clientDomain.create({ data: { domain, label: 'Exact product' } });
    const owner = await db.user.create({ data: { email, userKey: email, twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: TEST_SHARED_SECRET }) } });
    const org = await db.organisation.create({ data: { domain, ownerId: owner.id, name: 'Canonical destination', slug: suffix } });
    await db.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org.id, enforcement: 'required_for_all_members' } });
    const connection = await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: org.id,
      protocol: 'oidc', preset: 'other_oidc', displayName: 'Corporate', configuration: {} } });
    await db.externalIdentity.create({ data: { clientDomain: domain, orgId: org.id, userId: owner.id, connectionId: connection.id,
      issuer: 'https://issuer.example.com', tenant: 'tenant', subject: suffix, identityScope: 'global', linkedVia: 'independent_account_proof' } });
    const input = { config, configUrl, orgId: org.id, email, codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' as const, state: 'management-only' };
    return { domain, owner, org, secret, input };
  }
  const code = (secret: string) => computeTotp({ secret, nowMs: Date.now() });
  it('keeps account hints opaque and commits six failed guesses without minting any proof', async () => {
    const f = await fixture(); const known = await startManagementPersonalFactor(f.input, db);
    const unknown = await startManagementPersonalFactor({ ...f.input, email: 'unknown@example.com' }, db);
    expect(Object.keys(unknown.response)).toEqual(Object.keys(known.response));
    expect(unknown.response.org).toEqual(known.response.org); expect(unknown.response.client_domain).toBe(f.domain);
    const attempt = { config: f.input.config, configUrl: f.input.configUrl, browser: unknown.browser,
      challenge: unknown.response.challenge, code: '000000' };
    for (let n = 0; n < 7; n++) await expect(verifyManagementPersonalFactor(attempt, db)).rejects.toThrow('SSO_MANAGEMENT_REAUTH_REQUIRED');
    const row = await db.orgSsoManagementFactorChallenge.findUniqueOrThrow({ where: { tokenHash: hashAssuranceReference(unknown.response.challenge) } });
    expect(row.attempts).toBe(6); expect(row.userId).toBeNull();
    expect(await db.authenticationEvidence.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await app.orgSsoManagementFactorChallenge.findMany()).toEqual([]);
  });
  it('restores Google-only enrolled owner continuity without product code, refresh family or global token', async () => {
    const f = await fixture(); expect(f.owner.passwordHash).toBeNull();
    await expect(assertMailboxCredentialAdmission(f.owner.id, db)).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    const start = await startManagementPersonalFactor(f.input, db);
    const verify = { config: f.input.config, configUrl: f.input.configUrl, challenge: start.response.challenge, code: code(f.secret), browser: start.browser };
    await expect(verifyManagementPersonalFactor({ ...verify, browser: 'foreign-browser' }, db)).rejects.toThrow();
    const result = await verifyManagementPersonalFactor(verify, db);
    const url = new URL(result.redirectTo); expect(url.pathname).toBe('/auth/organisation-access'); expect(url.search).toBe('');
    const continuation = new URLSearchParams(url.hash.slice(1)).get('continuation')!;
    await expect(exchangeManagementContinuation(continuation, 'foreign-browser', db)).rejects.toThrow();
    const exchanged = await exchangeManagementContinuation(continuation, result.browser, db);
    const session = await managementSession(exchanged.browser, undefined, false, db);
    expect(session).toMatchObject({ orgId: f.org.id, userId: f.owner.id, clientDomain: f.domain });
    const evidence = await db.authenticationEvidence.findUniqueOrThrow({ where: { id: session.authenticationEvidenceId! } });
    expect(evidence).toMatchObject({ purpose: 'management', method: 'personal_totp', provenance: 'independent' });
    expect(evidence.parentId).toEqual(expect.any(String)); expect(evidence.mfaCompletedAt).not.toBeNull();
    expect(await db.authorizationCode.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await db.refreshToken.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await db.sessionAssurance.count({ where: { userId: f.owner.id } })).toBe(0);
    await expect(verifyManagementPersonalFactor(verify, db)).rejects.toThrow();
    await expect(exchangeManagementContinuation(continuation, result.browser, db)).rejects.toThrow();
  });
  it('pins configuration and immutable source before attempting the old personal factor', async () => {
    const f = await fixture(); const start = await startManagementPersonalFactor(f.input, db);
    const verify = { config: f.input.config, configUrl: f.input.configUrl, challenge: start.response.challenge, code: code(f.secret), browser: start.browser };
    await expect(verifyManagementPersonalFactor({ ...verify, configUrl: 'https://foreign.example.com/config' }, db)).rejects.toThrow();
    const row = await db.orgSsoManagementFactorChallenge.findUniqueOrThrow({ where: { tokenHash: hashAssuranceReference(verify.challenge) } });
    expect(row.attempts).toBe(0);
    await expect(db.orgSsoManagementFactorChallenge.update({ where: { id: row.id }, data: { configUrl: 'https://foreign.example.com/config' } })).rejects.toThrow('immutable');
    await db.user.update({ where: { id: f.owner.id }, data: { twoFaSecret: encryptTwoFaSecret({ secret: generateTotpSecret(), sharedSecret: TEST_SHARED_SECRET }) } });
    await expect(verifyManagementPersonalFactor(verify, db)).rejects.toThrow();
    expect(await db.orgSsoManagementSession.count({ where: { userId: f.owner.id } })).toBe(0);
  });
  it.each(['epoch', 'ownership', 'lifecycle'] as const)('rejects changed %s at final proof', async change => {
    const f = await fixture(); const start = await startManagementPersonalFactor(f.input, db);
    if (change === 'epoch') await db.user.update({ where: { id: f.owner.id }, data: { tokenVersion: { increment: 1 } } });
    else if (change === 'lifecycle') await db.organisation.update({ where: { id: f.org.id }, data: { lifecycleStatus: 'DISABLED' } });
    else {
      const other = await db.user.create({ data: { userKey: randomUUID(), email: `${randomUUID()}@example.com` } });
      await db.organisation.update({ where: { id: f.org.id }, data: { ownerId: other.id } });
    }
    await expect(verifyManagementPersonalFactor({ config: f.input.config, configUrl: f.input.configUrl,
      challenge: start.response.challenge, code: code(f.secret), browser: start.browser }, db)).rejects.toThrow();
    expect(await db.orgSsoManagementSession.count({ where: { userId: f.owner.id } })).toBe(0);
  });
});

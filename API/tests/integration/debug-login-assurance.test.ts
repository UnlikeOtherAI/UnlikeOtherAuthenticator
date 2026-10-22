import { randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { issueDebugLogin, redeemDebugLogin } from '../../src/services/debug-login.service.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';

describe('debug sign-in preserves original assurance with PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const saved = Object.fromEntries(['DATABASE_URL', 'DATABASE_ADMIN_URL', 'SHARED_SECRET',
    'ENTERPRISE_SSO_CUSTODY_PROVIDER', 'ENTERPRISE_SSO_KEYRING'].map(key => [key, process.env[key]]));
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL is required for assurance lineage coverage');
    handle = created;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = 'debug-assurance-test-secret-with-enough-length';
    process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER = 'local';
    process.env.ENTERPRISE_SSO_KEYRING = JSON.stringify({ current: 'test', keys: {
      test: randomBytes(32).toString('base64'),
    } });
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });

  async function fixture(method: 'sso' | 'independent', withProof = true) {
    const db = handle.prisma;
    const domain = `debug-${randomUUID()}.example.com`;
    const configUrl = `https://${domain}/config`;
    const config = validateConfigFields(baseClientConfigPayload({ domain,
      redirect_urls: [`https://${domain}/callback`], org_features: { enabled: true, user_needs_team: false },
      login_flow: { email_code_enabled: false, team_selection: 'off' } }));
    const client = await db.clientDomain.create({ data: { domain, label: 'Debug assurance', status: 'active' } });
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1 } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    await db.domainRole.create({ data: { domain, userId: user.id, role: 'SUPERUSER' } });
    const org = await db.organisation.create({ data: { domain, ownerId: user.id, name: 'Debug test', slug: randomUUID() } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'Debug team', slug: randomUUID() } });
    await db.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'admin' } });
    const policy = await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org.id,
      arrangementEnabled: true, enforcement: method === 'sso' ? 'required_for_all_members' : 'off' } });
    const connection = method === 'sso' ? await db.orgSsoConnection.create({ data: {
      clientDomain: domain, orgId: org.id, protocol: 'oidc', preset: 'other_oidc', displayName: 'Test',
      configuration: {}, status: 'active',
    } }) : null;
    const identity = connection ? await db.externalIdentity.create({ data: { connectionId: connection.id,
      clientDomain: domain, orgId: org.id, userId: user.id, issuer: 'https://idp.example.com', tenant: 'customer',
      subject: randomUUID(), identityScope: 'product', linkedVia: 'independent_session' } }) : null;
    const familyId = randomUUID();
    const refresh = await issueRefreshToken({ familyId, userId: user.id, domain, clientId: 'debug-client',
      configUrl, orgId: org.id, teamId: team.id, twoFaCompleted: false }, { prisma: db });
    const observedAt = new Date(Date.now() - 86_400_000);
    const expiresAt = new Date(Date.now() + 90_000);
    const parent = withProof ? await db.$transaction(async tx => {
      const issued = await issueSessionAssurance({ familyId, userId: user.id, clientDomain: domain,
        credentialEpoch: 0, orgId: org.id, teamId: team.id, method, observedAt, authenticatedAt: null,
        mfaSource: method === 'sso' ? 'upstream_claimed' : 'none', amr: [method === 'sso' ? 'idp' : 'pwd'],
        policyGeneration: policy.generation, connectionId: connection?.id, externalIdentityId: identity?.id,
        connectionRevision: connection?.revision, connectionGeneration: connection?.generation, expiresAt,
      }, tx);
      await tx.refreshToken.update({ where: { id: refresh.refreshTokenId }, data: { assuranceId: issued.assurance.id } });
      return issued.assurance;
    }) : null;
    return { parent, user, refresh, expiresAt, observedAt,
      context: { config, configUrl, clientId: 'debug-client', clientDomainId: client.id } };
  }

  it.each(['sso', 'independent'] as const)('keeps %s provenance, unknown authentication time and original expiry', async method => {
    const source = await fixture(method);
    const deps = { prisma: handle.prisma };
    const grant = await issueDebugLogin({ ...source.context, refreshToken: source.refresh.refreshToken }, deps);
    expect(grant.expires_in).toBeLessThanOrEqual(90);
    const received = await redeemDebugLogin({ ...source.context, token: grant.token }, deps);
    const claims = decodeJwt(received.accessToken);
    const child = await handle.prisma.sessionAssurance.findUniqueOrThrow({ where: { id: claims.assurance_id as string } });
    expect(child.parentId).toBe(source.parent!.id);
    expect(child.method).toBe(method);
    expect(child.authenticatedAt).toBeNull();
    expect(child.observedAt).toEqual(source.observedAt);
    expect(child.expiresAt.getTime()).toBeLessThanOrEqual(source.expiresAt.getTime());
    expect(received.refreshTokenExpiresInSeconds).toBeLessThanOrEqual(90);
    if (method === 'sso') {
      expect(claims.role).toBe('user');
      await expect(verifyAccessToken(received.accessToken, { prisma: handle.prisma,
        requirement: 'global_account_control' })).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    }
    await handle.prisma.sessionAssurance.update({ where: { id: source.parent!.id }, data: { revokedAt: new Date() } });
    await expect(verifyAccessToken(received.accessToken, { prisma: handle.prisma })).rejects.toThrow('INVALID_SESSION_ASSURANCE');
  });

  it('refuses pre-assurance families before creating a debug grant', async () => {
    const source = await fixture('independent', false);
    const before = await handle.prisma.debugLoginGrant.count({ where: { userId: source.user.id } });
    await expect(issueDebugLogin({ ...source.context, refreshToken: source.refresh.refreshToken },
      { prisma: handle.prisma })).rejects.toThrow('INVALID_SESSION_ASSURANCE');
    expect(await handle.prisma.debugLoginGrant.count({ where: { userId: source.user.id } })).toBe(before);
  });
});

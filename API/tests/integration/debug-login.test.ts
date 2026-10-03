import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { issueRefreshToken } from '../../src/services/refresh-token.service.js';
import { hashRefreshToken } from '../../src/services/refresh-token-replay.service.js';
import { issueDebugLogin, redeemDebugLogin } from '../../src/services/debug-login.service.js';
import { exchangeRefreshTokenForTokens } from '../../src/services/token.service.js';

const secret = 'debug-login-tests-secret-with-enough-length';
const domain = 'debug-login.example';
const configUrl = `https://${domain}/config`;
const config = validateConfigFields(baseClientConfigPayload({ domain,
  redirect_urls: [`https://${domain}/callback`], org_features: { enabled: false },
  login_flow: { email_code_enabled: false, team_selection: 'off' } }));

describe.skipIf(!process.env.DATABASE_URL)('durable single-use debug login', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let clientDomainId: string;
  const saved = { SHARED_SECRET: process.env.SHARED_SECRET, DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL };
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('Database required');
    handle = db;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
    process.env.SHARED_SECRET = secret;
    clientDomainId = (await handle.prisma.clientDomain.create({
      data: { domain, label: domain, status: 'active' },
    })).id;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });
  const context = () => ({ config, configUrl, clientId: 'debug-client', clientDomainId });
  const deps = () => ({ prisma: handle.prisma });
  async function source() {
    const user = await handle.prisma.user.create({ data: {
      email: `${randomUUID()}@example.com`, userKey: randomUUID(),
    } });
    const refresh = await issueRefreshToken({ userId: user.id, domain, configUrl,
      clientId: 'debug-client', twoFaCompleted: true }, { prisma: handle.prisma, sharedSecret: secret });
    return { user, refresh };
  }
  it('stores only a digest and issues exactly one fresh independent family under a race', async () => {
    const { refresh } = await source();
    const grant = await issueDebugLogin({ ...context(), refreshToken: refresh.refreshToken }, deps());
    expect(grant.expires_in).toBe(1800);
    const stored = await handle.prisma.debugLoginGrant.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(stored.tokenHash).not.toBe(grant.token);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = { ...deps(), beforeRedemptionLock: async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    } };
    const results = await Promise.allSettled([1, 2].map(() => redeemDebugLogin({ ...context(), token: grant.token }, concurrent)));
    expect(arrivals).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Expected winner');
    const newRow = await handle.prisma.refreshToken.findUniqueOrThrow({ where: {
      tokenHash: hashRefreshToken(winner.value.refreshToken, secret),
    } });
    expect(newRow.familyId).not.toBe(stored.sourceFamilyId);
    expect(winner.value.refreshToken).not.toBe(refresh.refreshToken);
    await expect(redeemDebugLogin({ ...context(), token: grant.token }, deps())).rejects.toThrow();
  });
  it('renewal checks ownership and invalidates the old code', async () => {
    const a = await source(); const b = await source();
    const old = await issueDebugLogin({ ...context(), refreshToken: a.refresh.refreshToken }, deps());
    await expect(issueDebugLogin({ ...context(), refreshToken: b.refresh.refreshToken,
      previousToken: old.token }, deps())).rejects.toThrow();
    const renewed = await issueDebugLogin({ ...context(), refreshToken: a.refresh.refreshToken,
      previousToken: old.token }, deps());
    await expect(redeemDebugLogin({ ...context(), token: old.token }, deps())).rejects.toThrow();
    await expect(redeemDebugLogin({ ...context(), token: renewed.token }, deps())).resolves.toBeDefined();
  });
  it('rejects expiry, changed app/environment, and credential revocation', async () => {
    const a = await source();
    const grant = await issueDebugLogin({ ...context(), refreshToken: a.refresh.refreshToken }, deps());
    for (const configUrl of [`https://${domain}:444/config`, `https://${domain}/other`, `https://${domain}/config?team=other`]) {
      await expect(redeemDebugLogin({ ...context(), configUrl, token: grant.token }, deps())).rejects.toThrow();
    }
    await expect(redeemDebugLogin({ ...context(), token: grant.token }, {
      ...deps(), now: () => new Date(Date.now() + 1800_001),
    })).rejects.toThrow();
    await handle.prisma.user.update({ where: { id: a.user.id }, data: { tokenVersion: { increment: 1 } } });
    await expect(redeemDebugLogin({ ...context(), token: grant.token }, deps())).rejects.toThrow();
  });
  it('survives source rotation but refuses family logout', async () => {
    const a = await source();
    const grant = await issueDebugLogin({ ...context(), refreshToken: a.refresh.refreshToken }, deps());
    await exchangeRefreshTokenForTokens({ ...context(), refreshToken: a.refresh.refreshToken,
      authenticatedClientDomainId: clientDomainId }, { prisma: handle.prisma, adminPrisma: handle.prisma });
    await expect(redeemDebugLogin({ ...context(), token: grant.token }, deps())).resolves.toBeDefined();
    const second = await source();
    const secondGrant = await issueDebugLogin({ ...context(), refreshToken: second.refresh.refreshToken }, deps());
    await handle.prisma.refreshToken.updateMany({ where: { userId: second.user.id }, data: { revokedAt: new Date() } });
    await expect(redeemDebugLogin({ ...context(), token: secondGrant.token }, deps())).rejects.toThrow();
  });
  it('uses current demoted roles and refuses removed team membership', async () => {
    const owner = await source(); const member = await source();
    const org = await handle.prisma.organisation.create({ data: {
      domain, name: 'Debug team', slug: randomUUID(), ownerId: owner.user.id,
    } });
    const team = await handle.prisma.team.create({ data: { orgId: org.id, name: 'Team', slug: randomUUID() } });
    await handle.prisma.orgMember.create({ data: { orgId: org.id, userId: member.user.id, role: 'admin' } });
    await handle.prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, teamRole: 'admin' } });
    const scoped = { ...context(), config: validateConfigFields(baseClientConfigPayload({ domain,
      redirect_urls: [`https://${domain}/callback`], org_features: { enabled: true, user_needs_team: false },
      login_flow: { email_code_enabled: false, team_selection: 'off' } })) };
    const refresh = await issueRefreshToken({ userId: member.user.id, domain, configUrl,
      clientId: 'debug-client', orgId: org.id, teamId: team.id, twoFaCompleted: true },
      { prisma: handle.prisma, sharedSecret: secret });
    const grant = await issueDebugLogin({ ...scoped, refreshToken: refresh.refreshToken }, deps());
    await handle.prisma.orgMember.updateMany({ where: { orgId: org.id, userId: member.user.id }, data: { role: 'member' } });
    await handle.prisma.teamMember.updateMany({ where: { teamId: team.id, userId: member.user.id }, data: { teamRole: 'member' } });
    const pair = await redeemDebugLogin({ ...scoped, token: grant.token }, deps());
    const claims = decodeJwt(pair.accessToken);
    expect(claims.org).toMatchObject({ org_role: 'member', team_roles: { [team.id]: 'member' } });
    const revokedGrant = await issueDebugLogin({ ...scoped, refreshToken: refresh.refreshToken }, deps());
    await handle.prisma.teamMember.updateMany({ where: { teamId: team.id, userId: member.user.id }, data: { status: 'REMOVED' } });
    await expect(redeemDebugLogin({ ...scoped, token: revokedGrant.token }, deps())).rejects.toThrow();
  });
  it('refuses new 2FA policy and subsecond remaining source lifetime', async () => {
    const a = await source();
    const grant = await issueDebugLogin({ ...context(), refreshToken: a.refresh.refreshToken }, deps());
    await handle.prisma.refreshToken.updateMany({ where: { userId: a.user.id }, data: { twoFaCompleted: false } });
    await handle.prisma.user.update({ where: { id: a.user.id }, data: { twoFaEnabled: true } });
    await expect(redeemDebugLogin({ ...context(), config: { ...config, '2fa_enabled': true }, token: grant.token }, deps())).rejects.toThrow();
    const b = await source();
    const short = await issueDebugLogin({ ...context(), refreshToken: b.refresh.refreshToken }, deps());
    await handle.prisma.refreshToken.updateMany({ where: { userId: b.user.id }, data: { expiresAt: new Date(Date.now() + 500) } });
    await expect(redeemDebugLogin({ ...context(), token: short.token }, deps())).rejects.toThrow();
  });

  it('redeems a supported themed source into a canonical family that can refresh normally', async () => {
    const a = await source();
    const themed = `${configUrl}?theme=nessie`;
    await handle.prisma.refreshToken.updateMany({ where: { userId: a.user.id }, data: { configUrl: themed } });
    const grant = await issueDebugLogin({ ...context(), configUrl: themed, refreshToken: a.refresh.refreshToken }, deps());
    const pair = await redeemDebugLogin({ ...context(), token: grant.token }, deps());
    const refreshed = await exchangeRefreshTokenForTokens({ ...context(), refreshToken: pair.refreshToken,
      authenticatedClientDomainId: clientDomainId }, { prisma: handle.prisma, adminPrisma: handle.prisma });
    expect(refreshed.refreshToken).not.toBe(pair.refreshToken);
  });

});

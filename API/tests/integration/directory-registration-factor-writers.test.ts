import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAdminPrisma } from '../../src/db/prisma.js';
import { asPrismaClient, runInTransaction } from '../../src/db/tenant-context.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { placeUserInConfiguredOrganisation } from '../../src/services/org-placement.service.js';
import { ensureUserHasRequiredTeam } from '../../src/services/user-team-requirement.service.js';
import { loginWithSocialProfile } from '../../src/services/social/social-login.service.js';
import { enrollTwoFactorForUser } from '../../src/services/twofactor-enroll.service.js';
import { verifyTwoFactorForLogin } from '../../src/services/twofactor-login.service.js';
import { disableTwoFactorForUser, resetTwoFactorForUser } from '../../src/services/twofactor-disable.service.js';
import { verifyLifecycleStatus } from '../../src/services/lifecycle-status.service.js';
import { generateTotpSecret } from '../../src/services/totp.service.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { computeTotp } from '../helpers/totp.js';
import { socketRequest } from '../helpers/http-socket.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain } from '../helpers/profile-directory-fixture.js';

describe.skipIf(!process.env.DATABASE_URL)('registration, social and private factor canonical writer transactions', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>, retain = false;
  beforeAll(async () => { suite = await createProfileDirectoryFixture(); });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });
  const config = (extra: Record<string, unknown> = {}) => validateConfigFields(baseClientConfigPayload({ domain,
    user_scope: 'global', org_features: { enabled: true }, ...extra }));
  async function user() {
    const email = `${randomUUID()}@example.com`;
    return suite.db.user.create({ data: { email, userKey: email } });
  }
  const events = (orgId: string) => suite.db.directoryChangeOutbox.findMany({ where: { orgId }, orderBy: { revision: 'asc' },
    select: { revision: true, kind: true, subjectId: true, teamId: true } });
  async function enrolled(userId: string) {
    const secret = generateTotpSecret(), nowMs = Date.now();
    await enrollTwoFactorForUser({ userId, totpSecret: secret,
      code: computeTotp({ secret, nowMs: nowMs - 30_000 }) }, { prisma: getAdminPrisma() });
    return { secret, nowMs };
  }

  it('atomically auto-creates the canonical org, default team and both owner memberships', async () => {
    const target = await user();
    const result = await placeUserInConfiguredOrganisation({ userId: target.id, email: target.email!,
      config: config({ org_features: { enabled: true, auto_create_personal_org_on_first_login: true } }) }, { prisma: getAdminPrisma() });
    expect(result.status).toBe('auto_created');
    if (result.status !== 'auto_created') throw new Error('Placement refused');
    expect((await suite.db.organisation.findUniqueOrThrow({ where: { id: result.orgId } })).ownerId).toBe(target.id);
    expect(await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: result.orgId, userId: target.id } } })).toMatchObject({ role: 'owner', status: 'ACTIVE' });
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: result.teamId, userId: target.id } } })).toMatchObject({ teamRole: 'owner', status: 'ACTIVE' });
    expect(await events(result.orgId)).toEqual([{ revision: 1n, kind: 'organisation.changed', subjectId: null, teamId: null }]);
  });

  it('maps fresh canonical membership into explicit and default teams with one ordered event each', async () => {
    const f = await suite.subject();
    for (const teamId of [f.team.id, undefined]) {
      const target = await user();
      const result = await placeUserInConfiguredOrganisation({ userId: target.id, email: target.email!,
        config: config({ registration_domain_mapping: [{ email_domain: 'example.com', org_id: f.org.id, ...(teamId ? { team_id: teamId } : {}) }] }) },
      { prisma: getAdminPrisma() });
      expect(result).toEqual({ status: 'placed', orgId: f.org.id, teamId: f.team.id });
      expect(await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: target.id } } })).toMatchObject({ role: 'member', status: 'ACTIVE' });
      expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: f.team.id, userId: target.id } } })).toMatchObject({ teamRole: 'member', status: 'ACTIVE' });
    }
    expect((await events(f.org.id)).map(row => [row.revision, row.kind, row.teamId])).toEqual([
      [1n, 'membership.changed', f.team.id], [2n, 'membership.changed', f.team.id],
    ]);
  });

  it('publishes the existing-org first-team branch and its canonical role update together', async () => {
    const f = await suite.subject(), target = await user();
    const member = await suite.db.orgMember.create({ data: { orgId: f.org.id, userId: target.id, role: 'member' } });
    const result = await ensureUserHasRequiredTeam({ userId: target.id,
      config: config({ org_features: { enabled: true, user_needs_team: true } }) }, { prisma: getAdminPrisma() });
    expect(result?.orgId).toBe(f.org.id);
    expect((await suite.db.orgMember.findUniqueOrThrow({ where: { id: member.id } })).role).toBe('admin');
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: result!.teamId, userId: target.id } } })).toMatchObject({ teamRole: 'admin', status: 'ACTIVE' });
    expect(await events(f.org.id)).toEqual([{ revision: 1n, kind: 'team.changed', subjectId: target.id, teamId: null }]);
  });

  it('rolls back first placement, both memberships, revision and event with its enclosing auth transaction', async () => {
    const target = await user();
    await expect(runInTransaction(getAdminPrisma(), async tx => {
      await ensureUserHasRequiredTeam({ userId: target.id,
        config: config({ org_features: { enabled: true, user_needs_team: true } }) }, { prisma: tx });
      throw new Error('Forced placement rollback');
    })).rejects.toThrow('Forced placement rollback');
    expect(await suite.db.organisation.count({ where: { ownerId: target.id } })).toBe(0);
    expect(await suite.db.orgMember.count({ where: { userId: target.id } })).toBe(0);
    expect(await suite.db.teamMember.count({ where: { userId: target.id } })).toBe(0);
    expect(await suite.db.directoryChangeOutbox.count({ where: { subjectId: target.id } })).toBe(0);
  });

  it('creates a new unbound social identity once and publishes existing profile changes to owner-only scope', async () => {
    const email = `${randomUUID()}@example.com`, profile = { provider: 'google' as const, email, emailVerified: true,
      name: 'Provider name', avatarUrl: 'https://media.example.com/provider.png' };
    const first = await loginWithSocialProfile({ profile, config: config() }, { prisma: getAdminPrisma() });
    if (first.status !== 'authenticated') throw new Error('Social registration refused');
    const org = await suite.db.organisation.create({ data: { domain, name: 'Social owner-only scope', slug: randomUUID(), ownerId: first.userId } });
    const second = await loginWithSocialProfile({ profile: { ...profile, name: 'Updated provider name', avatarUrl: null }, config: config() }, { prisma: getAdminPrisma() });
    expect(second).toMatchObject({ status: 'authenticated', userId: first.userId });
    expect(await suite.db.user.count({ where: { email } })).toBe(1);
    expect(await suite.db.user.findUniqueOrThrow({ where: { id: first.userId } })).toMatchObject({ name: 'Updated provider name', avatarUrl: null, passwordHash: null });
    expect(await events(org.id)).toEqual([{ revision: 1n, kind: 'profile.changed', subjectId: first.userId, teamId: null }]);
  });

  it('persists encrypted enrollment and atomically consumes one concurrent login counter without directory payloads', async () => {
    const f = await suite.subject(), factor = await enrolled(f.owner.id);
    const row = await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } });
    expect(row.twoFaEnabled).toBe(true);
    expect(row.twoFaSecret === factor.secret).toBe(false);
    const code = computeTotp({ secret: factor.secret, nowMs: factor.nowMs });
    const outcomes = await Promise.allSettled([1, 2].map(() => verifyTwoFactorForLogin({ userId: f.owner.id, code },
      { prisma: getAdminPrisma(), now: () => new Date(factor.nowMs) })));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).twoFaLastAcceptedCounter).toBe(Math.floor(factor.nowMs / 30_000));
    expect(await events(f.org.id)).toEqual([]);
  });

  it('disables with fresh real TOTP and commits exactly one epoch invalidation', async () => {
    const f = await suite.subject(), factor = await enrolled(f.owner.id);
    await disableTwoFactorForUser({ userId: f.owner.id, code: computeTotp({ secret: factor.secret, nowMs: Date.now() }),
      credentialEpoch: 0, config: config({ '2fa_enabled': true }), orgId: f.org.id }, { prisma: getAdminPrisma() });
    expect(await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).toMatchObject({
      twoFaEnabled: false, twoFaSecret: null, twoFaLastAcceptedCounter: null, tokenVersion: 1,
    });
    expect(await events(f.org.id)).toEqual([{ revision: 1n, kind: 'credential_epoch.changed', subjectId: f.owner.id, teamId: null }]);
  });

  it('rolls back private factor clearing, global epoch and invalidation together, then resets normally', async () => {
    const f = await suite.subject();
    await enrolled(f.owner.id);
    await expect(getAdminPrisma().$transaction(async tx => {
      await resetTwoFactorForUser({ userId: f.owner.id }, { prisma: asPrismaClient(tx) });
      throw new Error('Forced factor reset rollback');
    })).rejects.toThrow('Forced factor reset rollback');
    expect(await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).toMatchObject({ twoFaEnabled: true, tokenVersion: 0 });
    expect(await events(f.org.id)).toEqual([]);
    await resetTwoFactorForUser({ userId: f.owner.id }, { prisma: getAdminPrisma() });
    expect(await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).toMatchObject({ twoFaEnabled: false, twoFaSecret: null, tokenVersion: 1 });
    expect(await events(f.org.id)).toEqual([{ revision: 1n, kind: 'credential_epoch.changed', subjectId: f.owner.id, teamId: null }]);
  });

  it('consumes lifecycle-status TOTP privately without creating login authority or directory profile events', async () => {
    const f = await suite.subject(), factor = await enrolled(f.owner.id), id = randomUUID(), code = '123456';
    const configUrl = `https://${domain}/auth-config`;
    await suite.db.verificationToken.create({ data: { id, type: 'LIFECYCLE_STATUS', email: f.owner.email!,
      userKey: f.owner.userKey, userId: f.owner.id, tokenVersion: 0, domain, configUrl,
      tokenHash: hashEmailToken(`lifecycle:${id}:${code}`, process.env.SHARED_SECRET!), expiresAt: new Date(Date.now() + 60_000) } });
    const result = await verifyLifecycleStatus({ config: config(), configUrl, challengeId: id, code,
      twoFactorCode: computeTotp({ secret: factor.secret, nowMs: Date.now() }) });
    expect(result.user).toMatchObject({ id: f.owner.id, status: 'ACTIVE' });
    expect((await suite.db.verificationToken.findUniqueOrThrow({ where: { id } })).usedAt).not.toBeNull();
    expect(await suite.db.refreshToken.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await suite.db.authorizationCode.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });

  it('sets an existing null-password account and blank name over HTTP with atomic profile/epoch invalidations', async () => {
    const f = await suite.subject(), rawToken = randomUUID();
    await suite.db.user.update({ where: { id: f.owner.id }, data: { name: null } });
    const configUrl = `https://${domain}/auth-config`;
    await suite.db.verificationToken.create({ data: { type: 'VERIFY_EMAIL_SET_PASSWORD', email: f.owner.email!,
      userKey: f.owner.userKey, userId: f.owner.id, tokenVersion: 0, domain: null, configUrl,
      tokenHash: hashEmailToken(rawToken, process.env.SHARED_SECRET!), expiresAt: new Date(Date.now() + 60_000) } });
    const base = await suite.app.listen({ host: '127.0.0.1', port: 0 });
    const query = new URLSearchParams({ config_url: configUrl, code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', code_challenge_method: 'S256' });
    const response = await socketRequest(base, '/auth/verify-email?' + query, { method: 'POST',
      json: { token: rawToken, password: 'Synthetic-password-123!', name: 'Verified canonical name' } });
    expect(response.status).toBe(200);
    const current = await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } });
    expect(current).toMatchObject({ name: 'Verified canonical name', tokenVersion: 1, email: f.owner.email });
    expect(Boolean(current.passwordHash)).toBe(true);
    expect(await suite.db.user.count({ where: { email: f.owner.email } })).toBe(1);
    expect(await events(f.org.id)).toEqual([
      { revision: 1n, kind: 'profile.changed', subjectId: f.owner.id, teamId: null },
      { revision: 2n, kind: 'credential_epoch.changed', subjectId: f.owner.id, teamId: null },
    ]);
  });
});

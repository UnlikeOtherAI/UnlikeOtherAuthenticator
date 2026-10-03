import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getAdminPrisma } from '../db/prisma.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { decryptTwoFaSecret } from '../utils/twofa-secret.js';
import { findMatchingTotpCounter } from './totp.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { buildUserIdentity } from './user-scope.service.js';
import { sendActionVerificationEmail } from './email.service.js';
import { extractEmailTheme } from './email-theme.service.js';
import type { ClientConfig } from './config.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';
import { getOAuthClient } from './oauth/client.service.js';
import type { Prisma } from '@prisma/client';

type Context = { config: ClientConfig; configUrl: string; native?: { clientId: string; redirectUri: string; revision: number } };
const digest = (id: string, code: string) => hashEmailToken(`lifecycle:${id}:${code}`, getEnv().SHARED_SECRET);
const failed = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');

/** This capability proves identity to read reasons only. It never creates an authenticated session. */
export async function startLifecycleStatus(input: Context & { email: string }) {
  const startedAt = Date.now();
  const id = randomUUID(), code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const { userKey } = buildUserIdentity({ email: input.email, domain: input.config.domain, userScope: input.config.user_scope });
  const email = await getAdminPrisma().$transaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    await assertCurrentNativeContext(tx, input);
    const found = await tx.user.findUnique({ where: { userKey } });
    if (!found) return null;
    await lockRefreshSessionUser(found.id, { prisma: tx });
    const user = await tx.user.findUnique({ where: { id: found.id } });
    if (!user?.email || !user.userKey || !['ACTIVE', 'DISABLED'].includes(user.lifecycleStatus)) return null;
    if (await tx.verificationToken.count({ where: { userId: user.id, type: 'LIFECYCLE_STATUS', createdAt: { gt: new Date(Date.now() - 15 * 60_000) } } }) >= 10) return null;
    await tx.verificationToken.updateMany({ where: { userId: user.id, type: 'LIFECYCLE_STATUS', domain: input.config.domain, usedAt: null }, data: { usedAt: new Date() } });
    await tx.verificationToken.create({ data: {
      id, type: 'LIFECYCLE_STATUS', email: user.email, userKey: user.userKey, userId: user.id,
      tokenVersion: user.tokenVersion, domain: input.config.domain, configUrl: input.configUrl,
      tokenHash: digest(id, code), expiresAt: new Date(Date.now() + 5 * 60_000),
    } });
    return user.email;
  });
  // Deliver the same neutral mail operation for known and unknown recipients. Only eligible
  // identities have a persisted challenge; no profile or login credential is created otherwise.
  await sendActionVerificationEmail({ to: email ?? input.email.trim().toLowerCase(), code, domain: input.config.domain,
    description: 'View your account access status', theme: extractEmailTheme(input.config) }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 250 - (Date.now() - startedAt))));
  return { ok: true, challengeId: id };
}

export async function verifyLifecycleStatus(input: Context & { challengeId: string; code: string; twoFactorCode?: string }) {
  const result = await getAdminPrisma().$transaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    await assertCurrentNativeContext(tx, input);
    const candidate = await tx.verificationToken.findUnique({ where: { id: input.challengeId } });
    if (!candidate?.userId) return null;
    await lockRefreshSessionUser(candidate.userId, { prisma: tx });
    const token = await tx.verificationToken.findUnique({ where: { id: input.challengeId } });
    const user = await tx.user.findUnique({ where: { id: candidate.userId } });
    if (!token || token.type !== 'LIFECYCLE_STATUS' || token.domain !== input.config.domain || token.configUrl !== input.configUrl
      || token.usedAt || token.expiresAt <= new Date() || token.attemptCount >= 5 || !user?.email
      || !['ACTIVE', 'DISABLED'].includes(user.lifecycleStatus) || token.tokenVersion !== user.tokenVersion) return null;
    await tx.verificationToken.update({ where: { id: token.id }, data: { attemptCount: { increment: 1 } } });
    const expected = Buffer.from(token.tokenHash), actual = Buffer.from(digest(token.id, input.code));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    if (user.twoFaEnabled) {
      if (!user.twoFaSecret || !input.twoFactorCode) return null;
      const counter = findMatchingTotpCounter({ secret: decryptTwoFaSecret({ encryptedSecret: user.twoFaSecret, sharedSecret: getEnv().SHARED_SECRET }), code: input.twoFactorCode, now: new Date() });
      if (counter === null || counter <= (user.twoFaLastAcceptedCounter ?? -1)) return null;
      await tx.user.update({ where: { id: user.id }, data: { twoFaLastAcceptedCounter: counter } });
    }
    await tx.verificationToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    const policy = await resolveProductTeamPolicy({ domain: input.config.domain }, { prisma: tx });
    const orgFilter = policy.scope === 'all_active_memberships' ? {} : { domain: input.config.domain };
    const memberships = await tx.orgMember.findMany({ where: { userId: user.id, status: 'ACTIVE', org: orgFilter }, include: { org: true } });
    const teams = await tx.teamMember.findMany({ where: { userId: user.id, status: 'ACTIVE', team: { org: orgFilter } }, include: { team: { include: { org: true } } } });
    return {
      user: { id: user.id, status: user.lifecycleStatus, reason: user.lifecycleReason },
      organisations: memberships.map(m => ({ id: m.orgId, name: m.org.name, status: m.org.lifecycleStatus, reason: m.org.lifecycleReason })),
      teams: teams.map(m => ({ id: m.teamId, name: m.team.name, status: m.team.lifecycleStatus, reason: m.team.lifecycleReason,
        parent: { id: m.team.orgId, name: m.team.org.name, status: m.team.org.lifecycleStatus, reason: m.team.org.lifecycleReason } })),
    };
  });
  if (!result) throw failed();
  return result;
}

async function assertCurrentNativeContext(tx: Prisma.TransactionClient, context: Context) {
  if (!context.native) return;
  const client = await getOAuthClient(context.native.clientId, tx);
  if (!client || !client.redirectUris.includes(context.native.redirectUri) || (client.nativeAppRevision ?? 0) !== context.native.revision) throw failed();
}

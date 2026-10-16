import { BillingAppKeyPurpose, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import { billingActorAudience } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import {
  lockProductTeamPolicyExclusive,
  lockProductTeamPolicyShared,
} from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser, lockRefreshSessionUserShared } from './refresh-session-lock.service.js';

export const DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT = '/apps/v1/deeptest/nessie-inference-access';

export async function getDeepTestNessieInferenceAccess(
  input: {
    credential: VerifiedBillingAppKey;
    actorToken: string;
    request: { product: string; organisationId: string; teamId: string; userId: string };
  },
  deps: { prisma?: PrismaClient; verifyActor?: typeof verifyBillingActor; now?: () => number } = {},
): Promise<{ allowed: boolean }> {
  if (input.request.product !== 'deeptest' || input.credential.service.identifier !== 'deeptest' ||
      input.credential.purpose !== BillingAppKeyPurpose.CUSTOMER_LIFECYCLE) {
    throw new AppError('FORBIDDEN', 403);
  }
  const actor = await (deps.verifyActor ?? verifyBillingActor)({
    token: input.actorToken,
    credential: input.credential,
    endpoint: DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT,
    request: input.request,
  });
  // This operator capability never accepts the billing legacy-audience transition.
  if (actor.aud !== billingActorAudience(DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT)) {
    throw new AppError('UNAUTHORIZED', 401, 'BILLING_ACTOR_AUDIENCE_MISMATCH');
  }
  const prisma = deps.prisma ?? getAdminPrisma();
  return runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyShared(tx);
    await lockRefreshSessionUserShared(input.request.userId, { prisma: tx });
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    // Expiration is checked again after potentially waiting for policy/credential writers.
    if (actor.exp <= now) throw new AppError('UNAUTHORIZED', 401);
    const [key, user, membership] = await Promise.all([
      tx.billingAppKey.findFirst({
        where: { id: input.credential.id, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
          actorIssuer: input.credential.actorIssuer, revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now * 1000) } }],
          service: { id: input.credential.service.id, identifier: 'deeptest', active: true } },
        select: { id: true },
      }),
      tx.user.findUnique({ where: { id: input.request.userId },
        select: { tokenVersion: true, lifecycleStatus: true, deeptestNessieInferenceAllowed: true } }),
      tx.orgMember.findFirst({
        where: { userId: input.request.userId, orgId: input.request.organisationId, status: 'ACTIVE',
          org: { lifecycleStatus: 'ACTIVE', teams: { some: {
            id: input.request.teamId, lifecycleStatus: 'ACTIVE',
            members: { some: { userId: input.request.userId, status: 'ACTIVE' } },
          } } } },
        select: { id: true },
      }),
    ]);
    if (!key || !user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== actor.tv || !membership) {
      throw new AppError('FORBIDDEN', 403);
    }
    return { allowed: user.deeptestNessieInferenceAllowed === true };
  });
}

export async function setDeepTestNessieInferenceAccess(
  input: { userId: string; allowed: boolean; actor: LifecycleActor },
  deps: { prisma?: PrismaClient } = {},
): Promise<{ allowed: boolean }> {
  return runInTransaction(deps.prisma ?? getAdminPrisma(), async (tx) => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, input.actor);
    await lockRefreshSessionUser(input.userId, { prisma: tx });
    const user = await tx.user.findUnique({ where: { id: input.userId },
      select: { lifecycleStatus: true, deeptestNessieInferenceAllowed: true } });
    if (!user) throw new AppError('NOT_FOUND', 404);
    if (input.allowed && user.lifecycleStatus !== 'ACTIVE') throw new AppError('FORBIDDEN', 403);
    await tx.user.update({ where: { id: input.userId },
      data: { deeptestNessieInferenceAllowed: input.allowed } });
    await tx.adminAuditLog.create({ data: { actorEmail,
      action: 'user.deeptest_nessie_inference_changed',
      metadata: { userId: input.userId, previousAllowed: user.deeptestNessieInferenceAllowed,
        allowed: input.allowed } } });
    return { allowed: input.allowed };
  });
}

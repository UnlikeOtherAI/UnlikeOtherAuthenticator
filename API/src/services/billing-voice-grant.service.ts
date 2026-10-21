import { Prisma, type BillingVoiceGrant, type PrismaClient } from '@prisma/client';
import type { BillingVoiceGrantRequestV1, BillingVoiceGrantReadRequestV1, BillingVoiceGrantV1,
  BillingSubjectRequest } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsCredential, lockSmsSubject, verifySmsActor, assertSmsTeamManager } from './billing-sms-authority.service.js';
import { authorizeBillingCustomerAction, BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

export function publicVoiceGrant(grant: BillingVoiceGrant): BillingVoiceGrantV1 {
  return { direction: grant.direction as BillingVoiceGrantV1['direction'], purpose: grant.purpose as BillingVoiceGrantV1['purpose'],
    max_concurrent_calls: grant.maxConcurrentCalls, destinations: grant.destinations, id: grant.id, number_id: grant.numberId, allocation_id: grant.allocationId,
    delegate_id: grant.delegateId, max_duration_seconds: grant.maxDurationSeconds, state: grant.revokedAt ? 'revoked' : 'active' };
}

export function grantSubject(grant: BillingVoiceGrant, product: string): BillingSubjectRequest {
  return { product, organisation_id: grant.orgId, team_id: grant.teamId, user_id: grant.userId };
}

/** Original human authority and original consent key remain live at each delegated dispatch. */
export async function lockVoiceGrant(tx: Prisma.TransactionClient, input: {
  grantId: string; product: string; credential: VerifiedBillingAppKey;
}): Promise<BillingVoiceGrant> {
  if (input.product !== input.credential.service.identifier) throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_voice_grants WHERE id = ${input.grantId} FOR SHARE`);
  const grant = await tx.billingVoiceGrant.findUnique({ where: { id: input.grantId } });
  if (!grant || grant.serviceId !== input.credential.service.id || grant.revokedAt) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_GRANT_REVOKED');
  }
  await lockSmsSubject(tx, { subject: grantSubject(grant, input.product),
    actor: { tv: grant.actorTokenVersion, exp: 0 }, credential: input.credential }, false);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_app_keys WHERE id = ${grant.appKeyId} FOR SHARE`);
  const originalKey = await tx.billingAppKey.findFirst({ where: {
    id: grant.appKeyId, serviceId: grant.serviceId, purpose: 'CUSTOMER_LIFECYCLE', revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], service: { active: true },
  }, select: { id: true } });
  if (!originalKey) throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_GRANT_REVOKED');
  const [org, team] = await Promise.all([
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId: grant.orgId, userId: grant.userId } },
      select: { role: true } }),
    tx.teamMember.findUnique({ where: { teamId_userId: { teamId: grant.teamId, userId: grant.userId } },
      select: { teamRole: true } }),
  ]);
  if (!org || !isBillingManager({ scope: 'TEAM', orgRole: org.role, teamRole: team?.teamRole })) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_VOICE_GRANT_REVOKED');
  }
  return grant;
}

export async function createVoiceGrant(input: { request: BillingVoiceGrantRequestV1; actorToken: string;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }): Promise<BillingVoiceGrantV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (input.credential.purpose !== 'CUSTOMER_LIFECYCLE' ||
      (input.request.direction === 'outbound' && !input.request.destinations.length) ||
      (input.request.direction === 'inbound' && input.request.destinations.length) ||
      (input.request.purpose === 'human_transfer' && input.request.direction !== 'outbound')) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_VOICE_GRANT_INVALID');
  }
  const actor = await verifySmsActor({ subject: input.request, actorToken: input.actorToken,
    credential: input.credential, endpoint: '/billing/v1/voice/grants' });
  await authorizeBillingCustomerAction({ credential: input.credential, actor,
    organisationId: input.request.organisation_id, teamId: input.request.team_id, userId: input.request.user_id,
    authorityScope: 'TEAM', operation: BILLING_CUSTOMER_ACTION.VOICE_DISPATCH_GRANT, request: input.request }, { prisma });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsSubject(tx, { subject: input.request, actor, credential: input.credential });
    await assertSmsTeamManager(tx, input.request);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.idempotency_key}, 0))::text`);
    const existing = await tx.billingVoiceGrant.findUnique({ where: { id: input.request.idempotency_key } });
    if (existing) {
      if (existing.serviceId !== input.credential.service.id || existing.orgId !== input.request.organisation_id ||
          existing.teamId !== input.request.team_id || existing.userId !== input.request.user_id ||
          existing.numberId !== input.request.number_id || existing.allocationId !== input.request.allocation_id ||
          existing.delegateId !== input.request.delegate_id || existing.maxDurationSeconds !== input.request.max_duration_seconds ||
          existing.actorTokenVersion !== actor.tv || existing.direction !== input.request.direction ||
          existing.purpose !== input.request.purpose || existing.maxConcurrentCalls !== input.request.max_concurrent_calls ||
          JSON.stringify(existing.destinations) !== JSON.stringify(input.request.destinations)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_GRANT_BINDING_CONFLICT');
      }
      return publicVoiceGrant(existing);
    }
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice-number:${input.request.number_id}`}, 0))::text`);
    const other = await tx.billingVoiceGrant.findFirst({ where: { numberId: input.request.number_id, revokedAt: null,
      OR: [{ teamId: { not: input.request.team_id } }, { allocationId: { not: input.request.allocation_id } }] } });
    if (other) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_ALLOCATION_CONFLICT');
    const number = await tx.billingSmsNumberResource.findFirst({ where: {
      id: input.request.number_id, orgId: input.request.organisation_id, serviceId: input.credential.service.id,
      state: 'active', phoneNumberSid: { not: null },
    } });
    if (!number) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_NUMBER_NOT_ACTIVE');
    return publicVoiceGrant(await tx.billingVoiceGrant.create({ data: {
      id: input.request.idempotency_key, direction: input.request.direction, purpose: input.request.purpose,
      destinations: input.request.destinations, maxConcurrentCalls: input.request.max_concurrent_calls,
      serviceId: input.credential.service.id, appKeyId: input.credential.id,
      orgId: input.request.organisation_id, teamId: input.request.team_id, userId: input.request.user_id,
      actorTokenVersion: actor.tv, numberId: input.request.number_id, allocationId: input.request.allocation_id,
      delegateId: input.request.delegate_id, maxDurationSeconds: input.request.max_duration_seconds,
    } }));
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function readVoiceGrant(input: { request: BillingVoiceGrantReadRequestV1;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }): Promise<BillingVoiceGrantV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    const grant = await tx.billingVoiceGrant.findUnique({ where: { id: input.request.grant_id } });
    if (!grant || grant.serviceId !== input.credential.service.id ||
        input.request.product !== input.credential.service.identifier) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_VOICE_GRANT_NOT_FOUND');
    }
    return publicVoiceGrant(grant);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function revokeVoiceGrant(input: { request: BillingVoiceGrantReadRequestV1;
  credential: VerifiedBillingAppKey }, deps?: { prisma?: PrismaClient }): Promise<BillingVoiceGrantV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (input.request.product !== input.credential.service.identifier) throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsCredential(tx, input.credential);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.request.grant_id}, 0))::text`);
    const grant = await tx.billingVoiceGrant.findUnique({ where: { id: input.request.grant_id } });
    if (!grant || grant.serviceId !== input.credential.service.id) throw new AppError('NOT_FOUND', 404);
    if (!grant.revokedAt) await tx.billingVoiceGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    return { ...publicVoiceGrant(grant), state: 'revoked' };
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

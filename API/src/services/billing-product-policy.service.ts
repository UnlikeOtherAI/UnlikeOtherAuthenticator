import { type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { commercialTimezone, defaultTrialEnd } from './billing-commercial-clock.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';

export async function listProductPolicies(serviceId: string, prisma = getAdminPrisma()) {
  const rows = await prisma.billingProductEnrollment.findMany({ where: { serviceId }, orderBy: { createdAt: 'desc' } });
  return Promise.all(rows.map(async (row) => ({ id: row.id, organisation_id: row.orgId,
    source_domain: row.sourceDomain, billing_timezone: row.billingTimezone, active: row.active,
    policy: await prisma.billingProductPolicyRevision.findFirst({ where: { enrollmentId: row.id },
      orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }) })));
}

export async function setProductPolicy(input: { serviceId: string; organisationId: string;
  sourceDomain: string; billingTimezone?: string; privateAtCost: boolean;
  startTrial?: boolean;
  trialStartsAt?: Date | null; trialEndsAt?: Date | null; actor: LifecycleActor },
  deps?: { prisma?: PrismaClient; now?: () => Date }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    const actorEmail = await requireLifecycleActor(tx as PrismaClient, input.actor);
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${input.organisationId} FOR UPDATE`;
    const now = deps?.now?.() ?? new Date();
    const [service, org, source] = await Promise.all([
      tx.billingService.findFirst({ where: { id: input.serviceId, active: true } }),
      tx.organisation.findFirst({ where: { id: input.organisationId, lifecycleStatus: 'ACTIVE' } }),
      tx.clientDomain.findFirst({ where: { domain: input.sourceDomain, status: 'active' } }),
    ]);
    if (!service || !org || !source) throw new AppError('NOT_FOUND', 404);
    const start = input.trialStartsAt ?? (input.startTrial ? now : null);
    const end = start ? input.trialEndsAt ?? defaultTrialEnd(start) : null;
    if ((start && (!end || start < now || end <= start)) || (!start && input.trialEndsAt) ||
      (input.privateAtCost && start)) throw new AppError('BAD_REQUEST', 400, 'BILLING_TRIAL_INVALID');
    let effectiveAt = now;
    let privateTermEventId: string | null = null;
    const oldEnrollment = await tx.billingProductEnrollment.findUnique({ where: {
      serviceId_orgId: { serviceId: input.serviceId, orgId: input.organisationId },
    } });
    const previous = oldEnrollment ? await tx.billingProductPolicyRevision.findFirst({ where: {
      enrollmentId: oldEnrollment.id }, orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }) : null;
    if (!input.privateAtCost && previous?.privateAtCost) {
      if (previous.effectiveAt > now) effectiveAt = previous.effectiveAt;
      else {
        const transition = await tx.billingTariffTermEvent.findFirst({ where: { serviceId: input.serviceId,
          source: 'ORGANISATION', scopeKey: input.organisationId,
          effectiveFromMonth: { gt: now.toISOString().slice(0, 7) }, id: { not: previous.privateTermEventId! } },
          orderBy: [{ effectiveFromMonth: 'asc' }, { sequence: 'desc' }] });
        if (!transition) throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_TRANSITION_TERMS_REQUIRED');
        effectiveAt = new Date(`${transition.effectiveFromMonth}-01T00:00:00.000Z`);
      }
    }
    if (start) {
      const incompatible = await tx.billingStripeSubscription.findFirst({ where: {
        serviceId: input.serviceId, orgId: input.organisationId,
        status: { notIn: ['canceled', 'incomplete_expired'] },
        tariff: { monthlyAmountMinor: { gt: 0 }, OR: [{ monthlyChargeBasis: 'FLAT' }, { seatChargeTiming: 'FULL_MONTH' }] },
      } });
      const manual = await tx.billingContractServiceTerm.findFirst({ where: {
        serviceId: input.serviceId, contractVersion: { contract: { orgId: input.organisationId, status: 'ACTIVE' } },
        tariff: { monthlyAmountMinor: { gt: 0 }, OR: [{ monthlyChargeBasis: 'FLAT' }, { seatChargeTiming: 'FULL_MONTH' }] },
      } });
      const monthlyBoundary = (date: Date) => date.getUTCDate() === 1 &&
        date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
      if ((incompatible || manual) && (!monthlyBoundary(start) || !monthlyBoundary(end!))) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CUSTOM_TRIAL_PARTIAL_WAIVER_UNSUPPORTED');
      }
    }
    if (input.privateAtCost) {
      const retailStorage = await tx.billingStorageMandate.findFirst({ where: { serviceId: input.serviceId,
        orgId: input.organisationId, state: 'accepted', revokedAt: null } });
      const retailSubscription = await tx.billingStorageSubscription.findFirst({ where: { serviceId: input.serviceId,
        orgId: input.organisationId, state: { notIn: ['canceled', 'ended', 'incomplete_expired'] } } });
      if (retailStorage || retailSubscription) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_RETAIL_STORAGE_ACTIVE');
      }
      // Private access may never be a fee waiver layered over marked-up or
      // uncollected inference. Require the separately agreed immutable tariff.
      const assignment = await tx.billingTariffAssignment.findFirst({ where: {
        serviceId: input.serviceId, orgId: input.organisationId, teamId: null,
      }, include: { tariff: true } });
      if (!assignment || assignment.tariff.mode !== 'AT_COST' ||
        assignment.tariff.monthlyAmountMinor !== 0n || assignment.tariff.collectionMode === 'NONE') {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_COLLECTING_TARIFF_REQUIRED');
      }
      const conflict = await tx.billingTariffAssignment.findFirst({ where: {
        serviceId: input.serviceId, orgId: input.organisationId, teamId: { not: null },
        OR: [{ tariff: { mode: { not: 'AT_COST' } } }, { tariff: { monthlyAmountMinor: { not: 0 } } },
          { tariff: { collectionMode: 'NONE' } }],
      } });
      if (conflict) throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_TEAM_OVERRIDE_CONFLICT');
      const event = await tx.billingTariffTermEvent.findFirst({ where: {
        serviceId: input.serviceId, source: 'ORGANISATION', scopeKey: input.organisationId,
        tariffId: assignment.tariffId, assignmentId: assignment.id,
      }, orderBy: [{ effectiveFromMonth: 'desc' }, { sequence: 'desc' }] });
      if (!event) throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_EFFECTIVE_EVIDENCE_REQUIRED');
      privateTermEventId = event.id;
      effectiveAt = new Date(Math.max(now.getTime(), Date.parse(`${event.effectiveFromMonth}-01T00:00:00.000Z`)));
    }
    const timezone = commercialTimezone(input.billingTimezone);
    const enrollment = await tx.billingProductEnrollment.upsert({ where: {
      serviceId_orgId: { serviceId: input.serviceId, orgId: input.organisationId },
    }, create: { serviceId: input.serviceId, orgId: input.organisationId, sourceDomain: input.sourceDomain,
      billingTimezone: timezone }, update: { billingTimezone: timezone } });
    if (enrollment.sourceDomain !== input.sourceDomain) throw new AppError('BAD_REQUEST', 409, 'BILLING_COMMERCIAL_SOURCE_IMMUTABLE');
    const revision = await tx.billingProductPolicyRevision.create({ data: { enrollmentId: enrollment.id,
      privateAtCost: input.privateAtCost, privateTermEventId, trialStartsAt: start, trialEndsAt: end,
      effectiveAt, actorUserId: input.actor.userId } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'billing.product_policy_assigned',
      metadata: { service_id: input.serviceId, organisation_id: input.organisationId,
        revision_id: revision.id, private_at_cost: input.privateAtCost,
        trial_starts_at: start?.toISOString() ?? null, trial_ends_at: end?.toISOString() ?? null,
        billing_timezone: timezone } } });
    return { id: revision.id, effective_at: effectiveAt.toISOString() };
  });
}

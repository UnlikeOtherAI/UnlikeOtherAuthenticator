import { type Prisma, type PrismaClient } from '@prisma/client';
import type { ProductEntitlementV1, ProductEntitlementManagerV1, ProductBackgroundRequest }
  from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { commercialMember, lockCommercialAuthority } from './billing-product-authority.service.js';
import { effectiveStorageCapacity } from './billing-storage-expansion.service.js';
import { privateCompanyPolicy } from './billing-product-private-policy.service.js';
export { FREE_STORAGE_BYTES, STORAGE_BLOCK_BYTES } from './billing-storage-units.service.js';

export async function productPolicyAt(tx: Prisma.TransactionClient, enrollmentId: string, now: Date) {
  return tx.billingProductPolicyRevision.findFirst({ where: { enrollmentId, effectiveAt: { lte: now } },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
}

export async function getProductEntitlement(input: {
  request: ProductBackgroundRequest; credential: VerifiedBillingAppKey; actorToken?: string;
}, deps?: { prisma?: PrismaClient; now?: () => Date }): Promise<ProductEntitlementV1 | ProductEntitlementManagerV1> {
  const { request, credential } = input;
  const background = credential.purpose === 'COMMERCIAL_WORKER';
  if (Boolean(request.team_id) !== Boolean(request.user_id) ||
      (!background && (!request.team_id || !request.user_id || !input.actorToken))) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_COMMERCIAL_SUBJECT_INVALID');
  }
  const actor = background ? null : await verifyBillingActor({ credential,
    token: input.actorToken ?? '', endpoint: '/billing/v1/product-entitlement',
    request: { product: request.product, organisationId: request.organisation_id,
      teamId: request.team_id ?? '', userId: request.user_id ?? '' } });
  const prisma = deps?.prisma ?? getAdminPrisma();
  return prisma.$transaction(async (tx) => {
    const enrollment = await lockCommercialAuthority(tx, { credential, product: request.product,
      organisationId: request.organisation_id, purpose: background ? 'COMMERCIAL_WORKER' : 'ENTITLEMENT' });
    const manager = request.team_id && request.user_id ? await commercialMember(tx, {
      organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id,
      ...(actor ? { tokenVersion: actor.tv } : {}),
    }) : false;
    const now = deps?.now?.() ?? new Date();
    const [policy, incident, observation, subscriptions] = await Promise.all([
      productPolicyAt(tx, enrollment.id, now),
      tx.billingCommercialIncident.findFirst({ where: { serviceId: credential.service.id,
        orgId: request.organisation_id, category: { in: ['seat', 'storage'] }, resolvedAt: null },
        orderBy: [{ graceEndsAt: 'asc' }, { failedAt: 'asc' }, { id: 'asc' }] }),
      tx.billingStorageObservation.findFirst({ where: { serviceId: credential.service.id,
        orgId: request.organisation_id }, orderBy: { revision: 'desc' } }),
      tx.billingSeatSubscription.findMany({ where: { serviceId: credential.service.id,
        orgId: request.organisation_id, teamId: null, commercialEffectiveAt: { lte: now }, endedAt: null,
        OR: [{ commercialEndsAt: null }, { commercialEndsAt: { gt: now } }],
      }, include: { capacityRevisions: { where: { effectiveAt: { lte: now } },
        orderBy: { effectiveAt: 'desc' }, take: 1 }, stripeSubscription: true } }),
    ]);
    const activeSeats = subscriptions.filter((row) => !row.stripeSubscription ||
      row.stripeSubscription.status === 'active' ||
      (row.stripeSubscription.status === 'past_due' && incident?.category === 'seat' &&
        incident.baseSubscriptionId === row.stripeSubscription.id));
    const trial = Boolean(policy?.trialStartsAt && policy.trialStartsAt <= now && policy.trialEndsAt && policy.trialEndsAt > now);
    const privatePlan = Boolean(await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, now));
    const restricted = Boolean(incident && incident.graceEndsAt <= now);
    const full = !restricted && (privatePlan || trial || activeSeats.length > 0 || incident?.category === 'seat');
    const fixed = activeSeats.filter((row) => row.seatPolicy === 'FIXED');
    const capacity = fixed.length ? Math.min(...fixed.map((row) => {
      if (!row.capacityRevisions[0]) throw new AppError('SERVICE_UNAVAILABLE', 503, 'SEAT_CAPACITY_RECONCILIATION_REQUIRED');
      return row.capacityRevisions[0].quantity;
    })) : null;
    const occupants = capacity === null ? [] : await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM billing_seat_eligible(${request.organisation_id}, NULL)`;
    const storage = await effectiveStorageCapacity(tx as PrismaClient, credential.service.id, request.organisation_id, now);
    const mandate = await tx.billingStorageMandate.findFirst({ where: { serviceId: credential.service.id,
      orgId: request.organisation_id, state: 'accepted', revokedAt: null, stripePaymentMethodId: { not: null } } });
    const boundaries = [now.getTime() + 60_000, ...(trial && policy?.trialEndsAt ? [policy.trialEndsAt.getTime()] : []),
      ...(incident && !restricted ? [incident.graceEndsAt.getTime()] : []),
      ...activeSeats.flatMap((row) => row.commercialEndsAt ? [row.commercialEndsAt.getTime()] : [])];
    const upcomingPolicy = await tx.billingProductPolicyRevision.findFirst({ where: {
      enrollmentId: enrollment.id, effectiveAt: { gt: now },
    }, orderBy: { effectiveAt: 'asc' } });
    if (upcomingPolicy) boundaries.push(upcomingPolicy.effectiveAt.getTime());
    const upcomingTerms = await tx.billingTariffTermEvent.findFirst({ where: { serviceId: credential.service.id,
      source: 'ORGANISATION', scopeKey: request.organisation_id,
      effectiveFromMonth: { gt: now.toISOString().slice(0, 7) } }, orderBy: { effectiveFromMonth: 'asc' } });
    if (upcomingTerms) boundaries.push(Date.parse(`${upcomingTerms.effectiveFromMonth}-01T00:00:00.000Z`));
    const base: ProductEntitlementV1 = { schema_version: 1, viewer: background ? 'background' : manager ? 'manager' : 'member',
      subject: request.team_id && request.user_id ? { team_id: request.team_id, user_id: request.user_id } : null,
      product: request.product, organisation_id: request.organisation_id,
      access: full ? 'full' : 'limited',
      full_access: full, history_window_days: full ? null : 14,
      trial_ends_at: trial ? policy?.trialEndsAt?.toISOString() ?? null : null,
      seats: { policy: full ? fixed.length ? 'fixed' : 'automatic' : 'free', capacity,
        admitted: Boolean(request.user_id && request.team_id),
        can_admit_members: full && (capacity === null || occupants.length < capacity) },
      storage: { capacity_bytes: storage.bytes.toString(),
        used_bytes: observation ? (observation.blobBytes + observation.databaseBytes).toString() : null,
        observed_at: observation?.observedAt.toISOString() ?? null,
        can_upload: !restricted, expansion_setup_required: !mandate },
      observed_at: now.toISOString(), valid_until: new Date(Math.min(...boundaries)).toISOString(),
    };
    if (!background && !manager) return base;
    return { ...base,
      standing: restricted ? 'restricted' : incident ? 'grace' : privatePlan ? 'private_at_cost'
        : trial ? 'trial' : activeSeats.length ? 'subscribed' : 'free',
      platform_fees_waived: privatePlan || trial, third_party_costs_payable: true,
      dunning: incident ? { incident_id: incident.id,
      category: incident.category as 'seat' | 'storage', failed_at: incident.failedAt.toISOString(),
      grace_ends_at: incident.graceEndsAt.toISOString(), billing_timezone: incident.billingTimezone } : null };
  });
}

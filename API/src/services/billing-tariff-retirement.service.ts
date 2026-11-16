import { BillingOrganisationContractStatus, Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockTariffHistoryService } from './billing-tariff-history.service.js';

/** Why a tariff version cannot be retired, in the order the operator should resolve them. */
export type TariffRetireBlocker = 'default' | 'assignments' | 'subscriptions' | 'contract_terms';

type BlockerReader = Pick<Prisma.TransactionClient, 'billingTariffAssignment' |
  'billingStripeSubscription' | 'billingSeatSubscription' | 'billingContractServiceTerm'>;

type MutationActor = { userId?: string | null; email: string };

const ENDED_STRIPE_STATUSES = ['canceled', 'incomplete_expired'];

/**
 * The one blocker computation, shared by the retire call and the read model. Four queries
 * whatever the number of tariffs; history (term events, settlements, reservations, ended
 * subscriptions, terminated contracts) never blocks.
 */
export async function tariffRetireBlockers(
  reader: BlockerReader,
  tariffs: ReadonlyArray<{ id: string; isDefault: boolean }>,
): Promise<Map<string, TariffRetireBlocker[]>> {
  const ids = tariffs.map((tariff) => tariff.id);
  const result = new Map<string, TariffRetireBlocker[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const tariffId = { in: ids };
  const [assignments, stripeSubscriptions, seatSubscriptions, contractTerms] = await Promise.all([
    reader.billingTariffAssignment.findMany({
      where: { tariffId }, select: { tariffId: true }, distinct: ['tariffId'],
    }),
    reader.billingStripeSubscription.findMany({
      where: { tariffId, status: { notIn: ENDED_STRIPE_STATUSES } },
      select: { tariffId: true }, distinct: ['tariffId'],
    }),
    reader.billingSeatSubscription.findMany({
      where: { tariffId, endedAt: null }, select: { tariffId: true }, distinct: ['tariffId'],
    }),
    reader.billingContractServiceTerm.findMany({
      where: { tariffId, contractVersion: { contract: {
        status: { not: BillingOrganisationContractStatus.TERMINATED } } } },
      select: { tariffId: true }, distinct: ['tariffId'],
    }),
  ]);
  const named = (...groups: Array<Array<{ tariffId: string }>>) =>
    new Set(groups.flat().map((row) => row.tariffId));
  const defaults = new Set(tariffs.filter((tariff) => tariff.isDefault).map((tariff) => tariff.id));
  const assigned = named(assignments);
  const subscribed = named(stripeSubscriptions, seatSubscriptions);
  const contracted = named(contractTerms);
  const checks: Array<[TariffRetireBlocker, Set<string>]> = [
    ['default', defaults], ['assignments', assigned], ['subscriptions', subscribed], ['contract_terms', contracted],
  ];
  for (const id of ids) {
    result.set(id, checks.filter(([, rows]) => rows.has(id)).map(([blocker]) => blocker));
  }
  return result;
}

/** A retired version can still be read and resolved, but never given to anybody new. */
export function assertTariffNotRetired(tariff: { retiredAt: Date | null }): void {
  if (tariff.retiredAt) throw new AppError('BAD_REQUEST', 409, 'BILLING_TARIFF_RETIRED');
}

function isSerializationConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2034';
}

async function changeRetirement(
  params: { serviceId: string; tariffId: string; actor: MutationActor; retire: boolean },
  deps?: { prisma?: PrismaClient; now?: () => Date },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockTariffHistoryService(tx, params.serviceId);
        const tariff = await tx.billingTariff.findFirst({
          where: { id: params.tariffId, serviceId: params.serviceId },
        });
        if (!tariff) throw new AppError('NOT_FOUND', 404, 'BILLING_TARIFF_NOT_FOUND');
        let current = tariff;
        if (params.retire !== Boolean(tariff.retiredAt)) {
          if (params.retire) {
            const blockers = (await tariffRetireBlockers(tx, [tariff])).get(tariff.id) ?? [];
            if (blockers.length > 0) throw new AppError('BAD_REQUEST', 409, 'BILLING_TARIFF_IN_USE');
          }
          current = await tx.billingTariff.update({
            where: { id: tariff.id },
            data: params.retire
              ? { retiredAt: (deps?.now ?? (() => new Date()))(), retiredByEmail: params.actor.email }
              : { retiredAt: null, retiredByEmail: null },
          });
          await tx.adminAuditLog.create({
            data: {
              actorEmail: params.actor.email,
              action: params.retire ? 'billing.tariff_version_retired' : 'billing.tariff_version_restored',
              metadata: {
                service_id: params.serviceId,
                tariff_id: tariff.id,
                tariff_key: tariff.key,
                tariff_version: tariff.version,
                tariff_name: tariff.name,
              },
            },
          });
        }
        const retireBlockedBy = (await tariffRetireBlockers(tx, [current])).get(current.id) ?? [];
        return { ...current, retireBlockedBy };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'BILLING_TARIFF_RETIREMENT_FAILED');
}

export async function retireBillingTariff(
  params: { serviceId: string; tariffId: string; actor: MutationActor },
  deps?: { prisma?: PrismaClient; now?: () => Date },
) {
  return changeRetirement({ ...params, retire: true }, deps);
}

export async function restoreBillingTariff(
  params: { serviceId: string; tariffId: string; actor: MutationActor },
  deps?: { prisma?: PrismaClient },
) {
  return changeRetirement({ ...params, retire: false }, deps);
}

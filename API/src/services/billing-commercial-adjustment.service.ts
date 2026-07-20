import {
  BillingAdjustmentCadence,
  BillingAdjustmentKind,
  BillingAssignmentScope,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

type AdjustmentPrisma = Pick<
  PrismaClient,
  | 'billingCommercialAdjustment'
  | 'billingService'
  | 'organisation'
  | 'team'
  | 'adminAuditLog'
  | '$transaction'
>;

function client(deps?: { prisma?: AdjustmentPrisma }): AdjustmentPrisma {
  return deps?.prisma ?? getAdminPrisma();
}

export type CommercialAdjustmentInput = {
  serviceId: string;
  organisationId: string;
  teamId?: string | null;
  key: string;
  name: string;
  kind: 'add_on' | 'credit';
  cadence: 'one_time' | 'monthly';
  amountMinor: string;
  currency: string;
  startsAt: Date;
  endsAt?: Date | null;
  createdBy?: { userId?: string | null; email?: string | null };
};

function normalizedInput(input: CommercialAdjustmentInput) {
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(input.amountMinor);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_ADJUSTMENT_INVALID');
  }
  if (
    !KEY_PATTERN.test(key) ||
    !name ||
    name.length > 160 ||
    !CURRENCY_PATTERN.test(currency) ||
    !/^(0|[1-9][0-9]*)$/.test(input.amountMinor) ||
    amountMinor > MAX_INT64 ||
    Number.isNaN(input.startsAt.getTime()) ||
    (input.endsAt && (Number.isNaN(input.endsAt.getTime()) || input.endsAt <= input.startsAt))
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_ADJUSTMENT_INVALID');
  }
  return {
    key,
    name,
    currency,
    amountMinor,
    kind: input.kind === 'credit' ? BillingAdjustmentKind.CREDIT : BillingAdjustmentKind.ADD_ON,
    cadence:
      input.cadence === 'monthly'
        ? BillingAdjustmentCadence.MONTHLY
        : BillingAdjustmentCadence.ONE_TIME,
  };
}

export async function createCommercialAdjustment(
  input: CommercialAdjustmentInput,
  deps?: { prisma?: AdjustmentPrisma },
) {
  const normalized = normalizedInput(input);
  const prisma = client(deps);
  const [service, org, team] = await Promise.all([
    prisma.billingService.findFirst({
      where: { id: input.serviceId, active: true },
      select: { id: true },
    }),
    prisma.organisation.findUnique({
      where: { id: input.organisationId },
      select: { id: true },
    }),
    input.teamId
      ? prisma.team.findFirst({
          where: { id: input.teamId, orgId: input.organisationId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (!service || !org || (input.teamId && !team)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_ADJUSTMENT_SCOPE_INVALID');
  }
  const scope = input.teamId ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION;
  return prisma.$transaction(async (tx) => {
    const adjustment = await tx.billingCommercialAdjustment.create({
      data: {
        serviceId: input.serviceId,
        orgId: input.organisationId,
        teamId: input.teamId ?? null,
        scope,
        scopeKey: input.teamId ? `${input.organisationId}:${input.teamId}` : input.organisationId,
        key: normalized.key,
        name: normalized.name,
        kind: normalized.kind,
        cadence: normalized.cadence,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        createdByUserId: input.createdBy?.userId ?? null,
        createdByEmail: input.createdBy?.email ?? null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: input.createdBy?.email ?? 'unknown',
        action: 'billing.commercial_adjustment_created',
        metadata: {
          adjustment_id: adjustment.id,
          service_id: adjustment.serviceId,
          organisation_id: adjustment.orgId,
          team_id: adjustment.teamId,
          kind: adjustment.kind.toLowerCase(),
          cadence: adjustment.cadence.toLowerCase(),
          amount_minor: adjustment.amountMinor.toString(),
          currency: adjustment.currency,
        },
      },
    });
    return adjustment;
  });
}

export async function listApplicableCommercialAdjustments(
  params: {
    serviceId: string;
    organisationId: string;
    teamId: string;
    startsAt: Date;
    endsAt: Date;
  },
  deps?: { prisma?: AdjustmentPrisma },
) {
  const rows = await client(deps).billingCommercialAdjustment.findMany({
    where: {
      serviceId: params.serviceId,
      orgId: params.organisationId,
      AND: [
        {
          OR: [
            { scope: BillingAssignmentScope.ORGANISATION, teamId: null },
            { scope: BillingAssignmentScope.TEAM, teamId: params.teamId },
          ],
        },
        {
          OR: [
            {
              cadence: BillingAdjustmentCadence.ONE_TIME,
              startsAt: { gte: params.startsAt, lt: params.endsAt },
              OR: [{ active: true }, { deactivatedAt: { gt: params.startsAt } }],
            },
            {
              cadence: BillingAdjustmentCadence.MONTHLY,
              startsAt: { lt: params.endsAt },
              AND: [
                { OR: [{ endsAt: null }, { endsAt: { gt: params.startsAt } }] },
                { OR: [{ active: true }, { deactivatedAt: { gt: params.startsAt } }] },
              ],
            },
          ],
        },
      ],
    },
    orderBy: [{ kind: 'asc' }, { key: 'asc' }, { startsAt: 'asc' }],
  });
  return rows.filter(
    (row) =>
      row.cadence !== BillingAdjustmentCadence.ONE_TIME ||
      row.active ||
      Boolean(row.deactivatedAt && row.deactivatedAt > row.startsAt),
  );
}

export async function deactivateCommercialAdjustment(
  params: {
    serviceId: string;
    adjustmentId: string;
    actor: { email?: string | null };
  },
  deps?: { prisma?: AdjustmentPrisma; now?: () => Date },
): Promise<void> {
  const prisma = client(deps);
  const now = deps?.now?.() ?? new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.billingCommercialAdjustment.updateMany({
      where: {
        id: params.adjustmentId,
        serviceId: params.serviceId,
        active: true,
      },
      data: { active: false, deactivatedAt: now },
    });
    if (updated.count !== 1) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_ADJUSTMENT_NOT_FOUND');
    }
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email ?? 'unknown',
        action: 'billing.commercial_adjustment_deactivated',
        metadata: {
          adjustment_id: params.adjustmentId,
          service_id: params.serviceId,
        },
      },
    });
  });
}

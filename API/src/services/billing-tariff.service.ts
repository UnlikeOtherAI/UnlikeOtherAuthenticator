import {
  BillingAssignmentScope,
  BillingTariffMode,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TARIFF_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MARKUP_BPS = 100_000;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export type PublicTariffMode = 'standard' | 'free' | 'at_cost' | 'custom';

export type TariffInput = {
  key: string;
  name: string;
  mode: PublicTariffMode;
  markupBps: number;
  monthlyAmountMinor: string;
  currency: string;
};

type NormalizedTariffInput = Omit<TariffInput, 'mode' | 'monthlyAmountMinor'> & {
  mode: BillingTariffMode;
  monthlyAmountMinor: bigint;
};

type MutationActor = {
  userId?: string | null;
  email: string;
};

function client(deps?: { prisma?: PrismaClient }): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

export function normalizeBillingServiceIdentifier(value: string): string {
  const identifier = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_SERVICE_IDENTIFIER');
  }
  return identifier;
}

function toDatabaseMode(mode: PublicTariffMode): BillingTariffMode {
  const mapped = {
    standard: BillingTariffMode.STANDARD,
    free: BillingTariffMode.FREE,
    at_cost: BillingTariffMode.AT_COST,
    custom: BillingTariffMode.CUSTOM,
  } as const;
  return mapped[mode];
}

export function normalizeTariffInput(input: TariffInput): NormalizedTariffInput {
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!TARIFF_KEY_PATTERN.test(key) || !name || name.length > 120) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_INPUT');
  }
  if (
    !Number.isInteger(input.markupBps) ||
    input.markupBps < 0 ||
    input.markupBps > MAX_MARKUP_BPS
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MARKUP');
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_CURRENCY');
  }

  let monthlyAmountMinor: bigint;
  try {
    monthlyAmountMinor = BigInt(input.monthlyAmountMinor);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_MONTHLY_AMOUNT');
  }
  if (
    monthlyAmountMinor < 0n ||
    monthlyAmountMinor > MAX_INT64 ||
    !/^(0|[1-9]\d*)$/.test(input.monthlyAmountMinor)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_MONTHLY_AMOUNT');
  }

  const mode = toDatabaseMode(input.mode);
  if (
    ((mode === BillingTariffMode.FREE || mode === BillingTariffMode.AT_COST) &&
      input.markupBps !== 0) ||
    (mode === BillingTariffMode.FREE && monthlyAmountMinor !== 0n)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MODE_VALUES');
  }

  return {
    key,
    name,
    mode,
    markupBps: input.markupBps,
    monthlyAmountMinor,
    currency,
  };
}

function auditActor(actor: MutationActor) {
  return {
    createdByUserId: actor.userId ?? null,
    createdByEmail: actor.email,
  };
}

export async function createBillingService(
  params: {
    identifier: string;
    name: string;
    defaultTariff: TariffInput;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
) {
  const identifier = normalizeBillingServiceIdentifier(params.identifier);
  const name = params.name.trim();
  const tariff = normalizeTariffInput(params.defaultTariff);
  if (!name || name.length > 120) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_SERVICE_NAME');
  }

  return client(deps).$transaction(
    async (tx) => {
      const existing = await tx.billingService.findUnique({
        where: { identifier },
        select: { id: true },
      });
      if (existing) {
        throw new AppError('BAD_REQUEST', 400, 'BILLING_SERVICE_EXISTS');
      }
      const service = await tx.billingService.create({
        data: { identifier, name },
      });
      const createdTariff = await tx.billingTariff.create({
        data: {
          serviceId: service.id,
          version: 1,
          isDefault: true,
          ...tariff,
          ...auditActor(params.actor),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorEmail: params.actor.email,
          action: 'billing.service_created',
          metadata: {
            service_id: service.id,
            product: service.identifier,
            default_tariff_id: createdTariff.id,
          },
        },
      });
      return { ...service, tariffs: [createdTariff] };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function listBillingServices(deps?: { prisma?: PrismaClient }) {
  return client(deps).billingService.findMany({
    orderBy: { identifier: 'asc' },
    include: {
      tariffs: { orderBy: [{ key: 'asc' }, { version: 'desc' }] },
      assignments: {
        orderBy: [{ scope: 'asc' }, { scopeKey: 'asc' }],
        include: {
          tariff: true,
          org: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
        },
      },
      appKeys: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          actorIssuer: true,
          actorAudience: true,
          actorKeyId: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdByEmail: true,
          createdAt: true,
        },
      },
    },
  });
}

function isVersionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

export async function createBillingTariffVersion(
  params: {
    serviceId: string;
    tariff: TariffInput;
    setAsDefault: boolean;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
) {
  const tariff = normalizeTariffInput(params.tariff);
  const prisma = client(deps);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const service = await tx.billingService.findUnique({
            where: { id: params.serviceId },
            select: { id: true, identifier: true, active: true },
          });
          if (!service?.active) {
            throw new AppError('NOT_FOUND', 404, 'BILLING_SERVICE_NOT_FOUND');
          }
          const latest = await tx.billingTariff.findFirst({
            where: { serviceId: service.id, key: tariff.key },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          if (params.setAsDefault) {
            await tx.billingTariff.updateMany({
              where: { serviceId: service.id, isDefault: true },
              data: { isDefault: false },
            });
          }
          const created = await tx.billingTariff.create({
            data: {
              serviceId: service.id,
              version: (latest?.version ?? 0) + 1,
              isDefault: params.setAsDefault,
              ...tariff,
              ...auditActor(params.actor),
            },
          });
          await tx.adminAuditLog.create({
            data: {
              actorEmail: params.actor.email,
              action: 'billing.tariff_version_created',
              metadata: {
                service_id: service.id,
                tariff_id: created.id,
                tariff_key: created.key,
                tariff_version: created.version,
                set_as_default: params.setAsDefault,
              },
            },
          });
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isVersionConflict(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'TARIFF_VERSION_CREATE_FAILED');
}

export async function setDefaultBillingTariff(
  params: {
    serviceId: string;
    tariffId: string;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = client(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const tariff = await tx.billingTariff.findFirst({
            where: { id: params.tariffId, serviceId: params.serviceId },
          });
          if (!tariff) throw new AppError('NOT_FOUND', 404, 'BILLING_TARIFF_NOT_FOUND');
          await tx.billingTariff.updateMany({
            where: { serviceId: params.serviceId, isDefault: true },
            data: { isDefault: false },
          });
          const updated = await tx.billingTariff.update({
            where: { id: tariff.id },
            data: { isDefault: true },
          });
          await tx.adminAuditLog.create({
            data: {
              actorEmail: params.actor.email,
              action: 'billing.default_tariff_changed',
              metadata: { service_id: params.serviceId, tariff_id: tariff.id },
            },
          });
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isVersionConflict(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'DEFAULT_TARIFF_UPDATE_FAILED');
}

export async function upsertBillingTariffAssignment(
  params: {
    serviceId: string;
    tariffId: string;
    organisationId: string;
    teamId?: string | null;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
) {
  return client(deps).$transaction(async (tx) => {
    const [service, tariff, org, team] = await Promise.all([
      tx.billingService.findUnique({
        where: { id: params.serviceId },
        select: { id: true, active: true },
      }),
      tx.billingTariff.findFirst({
        where: { id: params.tariffId, serviceId: params.serviceId },
        select: { id: true },
      }),
      tx.organisation.findUnique({
        where: { id: params.organisationId },
        select: { id: true },
      }),
      params.teamId
        ? tx.team.findFirst({
            where: { id: params.teamId, orgId: params.organisationId },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!service?.active || !tariff || !org || (params.teamId && !team)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_ASSIGNMENT');
    }

    const scope = params.teamId ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION;
    const scopeKey = params.teamId
      ? `${params.organisationId}:${params.teamId}`
      : params.organisationId;
    const assignment = await tx.billingTariffAssignment.upsert({
      where: {
        serviceId_scope_scopeKey: {
          serviceId: params.serviceId,
          scope,
          scopeKey,
        },
      },
      create: {
        serviceId: params.serviceId,
        tariffId: params.tariffId,
        orgId: params.organisationId,
        teamId: params.teamId ?? null,
        scope,
        scopeKey,
        ...auditActor(params.actor),
      },
      update: {
        tariffId: params.tariffId,
        createdByUserId: params.actor.userId ?? null,
        createdByEmail: params.actor.email,
      },
      include: { tariff: true },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.assignment_upserted',
        metadata: {
          service_id: params.serviceId,
          assignment_id: assignment.id,
          tariff_id: params.tariffId,
          scope: scope.toLowerCase(),
          organisation_id: params.organisationId,
          team_id: params.teamId ?? null,
        },
      },
    });
    return assignment;
  });
}

export async function removeBillingTariffAssignment(
  params: {
    serviceId: string;
    assignmentId: string;
    actor: MutationActor;
  },
  deps?: { prisma?: PrismaClient },
): Promise<void> {
  await client(deps).$transaction(async (tx) => {
    const assignment = await tx.billingTariffAssignment.findFirst({
      where: { id: params.assignmentId, serviceId: params.serviceId },
      select: { id: true, tariffId: true, scope: true, orgId: true, teamId: true },
    });
    if (!assignment) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_ASSIGNMENT_NOT_FOUND');
    }
    await tx.billingTariffAssignment.delete({ where: { id: assignment.id } });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.assignment_removed',
        metadata: {
          service_id: params.serviceId,
          assignment_id: assignment.id,
          tariff_id: assignment.tariffId,
          scope: assignment.scope.toLowerCase(),
          organisation_id: assignment.orgId,
          team_id: assignment.teamId,
        },
      },
    });
  });
}

export function billingModeToPublic(mode: BillingTariffMode): PublicTariffMode {
  const modes: Record<BillingTariffMode, PublicTariffMode> = {
    [BillingTariffMode.STANDARD]: 'standard',
    [BillingTariffMode.FREE]: 'free',
    [BillingTariffMode.AT_COST]: 'at_cost',
    [BillingTariffMode.CUSTOM]: 'custom',
  };
  return modes[mode];
}

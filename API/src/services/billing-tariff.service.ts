import {
  BillingAssignmentScope,
  BillingTariffSource,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeBillingServiceIdentifier, normalizeTariffInput, type TariffInput } from './billing-tariff-input.service.js';
export { normalizeBillingServiceIdentifier, normalizeTariffInput, DEFAULT_STANDARD_MARKUP_BPS } from './billing-tariff-input.service.js';
export type { TariffInput, PublicTariffMode, PublicBillingCollectionMode } from './billing-tariff-input.service.js';
import { AppError } from '../utils/errors.js';
import { normalizeProviderServiceRates } from './billing-provider-service-rate.service.js';
import {
  assertContractAssignmentRemovalAllowed,
  assertContractAssignmentWriteAllowed,
} from './billing-contract-guard.service.js';
import {
  assertDefaultTariffChangeAllowed,
  assertTariffAssignmentChangeAllowed,
  assertTariffAssignmentRemovalAllowed,
} from './billing-stripe-tariff-guard.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
import {
  appendTariffTermEvent,
  lockTariffHistoryService,
  nextUtcBillingMonth,
  utcBillingMonth,
} from './billing-tariff-history.service.js';

type MutationActor = {
  userId?: string | null;
  email: string;
};

function client(deps?: { prisma?: PrismaClient }): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
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
  const providerServiceRates = normalizeProviderServiceRates(params.defaultTariff.providerServiceRates, tariff);
  if (!name || name.length > 120) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_SERVICE_NAME');
  }

  return client(deps).$transaction(
    async (tx) => {
      await lockProductTeamPolicyExclusive(tx);
      const existing = await tx.billingService.findUnique({
        where: { identifier },
        select: { id: true },
      });
      if (existing) {
        throw new AppError('BAD_REQUEST', 400, 'BILLING_SERVICE_EXISTS');
      }
      const service = await tx.billingService.create({
        data: { identifier, name, tariffHistoryFromMonth: utcBillingMonth(new Date()) },
      });
      const createdTariff = await tx.billingTariff.create({
        data: {
          serviceId: service.id,
          version: 1,
          isDefault: true,
          ...tariff,
          ...auditActor(params.actor),
          providerServiceRates: { create: providerServiceRates },
        },
        include: { providerServiceRates: true },
      });
      await appendTariffTermEvent(tx, {
        serviceId: service.id,
        source: BillingTariffSource.SERVICE_DEFAULT,
        scopeKey: service.id,
        effectiveFromMonth: service.tariffHistoryFromMonth,
        tariffId: createdTariff.id,
        reason: 'service-created',
        actorEmail: params.actor.email,
      });
      await tx.adminAuditLog.create({
        data: {
          actorEmail: params.actor.email,
          action: 'billing.service_created',
          metadata: {
            service_id: service.id,
            product: service.identifier,
            default_tariff_id: createdTariff.id,
            provider_service_ids: providerServiceRates.map((rate) => rate.providerServiceId),
          },
        },
      });
      return { ...service, tariffs: [createdTariff] };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
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
  const providerServiceRates = normalizeProviderServiceRates(params.tariff.providerServiceRates, tariff);
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
          await lockTariffHistoryService(tx, service.id);
          const latest = await tx.billingTariff.findFirst({
            where: { serviceId: service.id, key: tariff.key },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          if (params.setAsDefault) {
            await assertDefaultTariffChangeAllowed(tx, service.id, '__new_tariff_version__');
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
              providerServiceRates: { create: providerServiceRates },
            },
            include: { providerServiceRates: true },
          });
          if (params.setAsDefault) {
            await appendTariffTermEvent(tx, {
              serviceId: service.id,
              source: BillingTariffSource.SERVICE_DEFAULT,
              scopeKey: service.id,
              effectiveFromMonth: nextUtcBillingMonth(new Date()),
              tariffId: created.id,
              reason: 'default-version-created',
              actorEmail: params.actor.email,
            });
          }
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
                provider_service_ids: providerServiceRates.map((rate) => rate.providerServiceId),
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
          if (tariff.isDefault) return tariff;
          await lockTariffHistoryService(tx, params.serviceId);
          await assertDefaultTariffChangeAllowed(tx, params.serviceId, tariff.id);
          await tx.billingTariff.updateMany({
            where: { serviceId: params.serviceId, isDefault: true },
            data: { isDefault: false },
          });
          const updated = await tx.billingTariff.update({
            where: { id: tariff.id },
            data: { isDefault: true },
          });
          await appendTariffTermEvent(tx, {
            serviceId: params.serviceId,
            source: BillingTariffSource.SERVICE_DEFAULT,
            scopeKey: params.serviceId,
            effectiveFromMonth: nextUtcBillingMonth(new Date()),
            tariffId: tariff.id,
            reason: 'default-changed',
            actorEmail: params.actor.email,
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
    await lockTariffHistoryService(tx, params.serviceId);
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
    await assertContractAssignmentWriteAllowed(tx, {
      serviceId: params.serviceId,
      organisationId: params.organisationId,
      teamId: params.teamId ?? null,
    });

    const scope = params.teamId ? BillingAssignmentScope.TEAM : BillingAssignmentScope.ORGANISATION;
    const scopeKey = params.teamId
      ? `${params.organisationId}:${params.teamId}`
      : params.organisationId;
    const current = await tx.billingTariffAssignment.findUnique({
      where: {
        serviceId_scope_scopeKey: {
          serviceId: params.serviceId,
          scope,
          scopeKey,
        },
      },
      select: { id: true, tariffId: true },
    });
    if (current?.tariffId !== params.tariffId) {
      await assertTariffAssignmentChangeAllowed(tx, {
        serviceId: params.serviceId,
        orgId: params.organisationId,
        teamId: params.teamId ?? null,
        targetTariffId: params.tariffId,
        currentAssignmentId: current?.id ?? null,
      });
    }
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
    if (current?.tariffId !== params.tariffId) {
      await appendTariffTermEvent(tx, {
        serviceId: params.serviceId,
        source: params.teamId ? BillingTariffSource.TEAM : BillingTariffSource.ORGANISATION,
        scopeKey,
        effectiveFromMonth: nextUtcBillingMonth(new Date()),
        tariffId: params.tariffId,
        assignmentId: assignment.id,
        reason: 'assignment-changed',
        actorEmail: params.actor.email,
      });
    }
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
    await lockTariffHistoryService(tx, params.serviceId);
    const assignment = await tx.billingTariffAssignment.findFirst({
      where: { id: params.assignmentId, serviceId: params.serviceId },
      select: { id: true, tariffId: true, scope: true, orgId: true, teamId: true },
    });
    if (!assignment) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_ASSIGNMENT_NOT_FOUND');
    }
    await assertContractAssignmentRemovalAllowed(tx, assignment.id);
    await assertTariffAssignmentRemovalAllowed(tx, assignment.id);
    await tx.billingTariffAssignment.delete({ where: { id: assignment.id } });
    await appendTariffTermEvent(tx, {
      serviceId: params.serviceId,
      source: assignment.scope === BillingAssignmentScope.TEAM
        ? BillingTariffSource.TEAM : BillingTariffSource.ORGANISATION,
      scopeKey: assignment.teamId
        ? `${assignment.orgId}:${assignment.teamId}` : assignment.orgId,
      effectiveFromMonth: nextUtcBillingMonth(new Date()),
      tariffId: null,
      reason: 'assignment-removed',
      actorEmail: params.actor.email,
    });
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

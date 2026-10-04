import {
  BillingAssignmentScope, BillingOrganisationContractStatus,
  BillingTariffSource, Prisma, type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  appendTariffTermEvent, lockTariffHistoryService,
} from './billing-tariff-history.service.js';
import {
  contractSeatTerms, createManualSeatAgreement, normalizeContractServices,
  type ContractServiceActivation, type NormalizedContractService,
} from './billing-contract-seat.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MARKUP_BPS = 100_000;

type Actor = { userId?: string | null; email: string };
type FinancialActor = Actor & LifecycleActor;
type ContractClient = PrismaClient;

function client(deps?: { prisma?: ContractClient }): ContractClient {
  return deps?.prisma ?? getAdminPrisma();
}

function cleanText(value: string, max: number, code: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) throw new AppError('BAD_REQUEST', 400, code);
  return cleaned;
}

function contractTariffKey(contractId: string): string {
  return `contract-${contractId}`.slice(0, 80);
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

async function lockStripeContractScopes(
  tx: Prisma.TransactionClient,
  organisationId: string,
  serviceIds: string[],
): Promise<void> {
  for (const serviceId of [...serviceIds].sort()) {
    await tx.$queryRaw(
      Prisma.sql`SELECT uoa_lock_stripe_contract_scope(${serviceId}, ${organisationId})::text AS "locked"`,
    );
  }
}

export async function listBillingContracts(
  params?: { organisationId?: string },
  deps?: { prisma?: ContractClient },
) {
  return client(deps).billingOrganisationContract.findMany({
    where: params?.organisationId ? { orgId: params.organisationId } : undefined,
    include: {
      org: { select: { id: true, name: true } },
      versions: {
        orderBy: { version: 'desc' },
        include: {
          serviceTerms: {
            orderBy: { serviceId: 'asc' },
            include: { service: true, tariff: true },
          },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

export async function createBillingContract(
  params: {
    organisationId: string;
    reference: string;
    name: string;
    actor: Actor;
  },
  deps?: { prisma?: ContractClient },
) {
  const reference = cleanText(params.reference, 100, 'BILLING_CONTRACT_REFERENCE_INVALID');
  const name = cleanText(params.name, 160, 'BILLING_CONTRACT_NAME_INVALID');
  if (!KEY_PATTERN.test(reference.toLowerCase())) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_REFERENCE_INVALID');
  }
  return client(deps).$transaction(async (tx) => {
    const org = await tx.organisation.findUnique({
      where: { id: params.organisationId },
      select: { id: true },
    });
    if (!org) throw new AppError('NOT_FOUND', 404, 'ORGANISATION_NOT_FOUND');
    const contract = await tx.billingOrganisationContract.create({
      data: {
        orgId: org.id,
        reference: reference.toLowerCase(),
        name,
        createdByUserId: params.actor.userId ?? null,
        createdByEmail: params.actor.email,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.contract_created',
        metadata: { contract_id: contract.id, organisation_id: contract.orgId },
      },
    });
    return contract;
  });
}

export async function createBillingContractVersion(
  params: {
    contractId: string;
    usageMarkupBps: number;
    currency: string;
    paymentTermsDays: number;
    effectiveFromMonth: string;
    actor: FinancialActor;
  },
  deps?: { prisma?: ContractClient },
) {
  const currency = params.currency.trim().toUpperCase();
  if (
    !Number.isSafeInteger(params.usageMarkupBps) ||
    params.usageMarkupBps < 0 ||
    params.usageMarkupBps > MAX_MARKUP_BPS ||
    !Number.isSafeInteger(params.paymentTermsDays) ||
    params.paymentTermsDays < 0 ||
    params.paymentTermsDays > 365 ||
    !CURRENCY_PATTERN.test(currency) ||
    !MONTH_PATTERN.test(params.effectiveFromMonth)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_VERSION_INVALID');
  }
  const prisma = client(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const actorEmail = await requireLifecycleActor(tx as PrismaClient, params.actor);
          const contract = await tx.billingOrganisationContract.findUnique({
            where: { id: params.contractId },
            include: {
              versions: {
                orderBy: { version: 'desc' },
                take: 1,
                select: { version: true, effectiveFromMonth: true },
              },
            },
          });
          if (!contract) throw new AppError('NOT_FOUND', 404, 'BILLING_CONTRACT_NOT_FOUND');
          if (contract.status === BillingOrganisationContractStatus.TERMINATED) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_TERMINATED');
          }
          const latest = contract.versions[0];
          if (latest && params.effectiveFromMonth <= latest.effectiveFromMonth) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_VERSION_NOT_FORWARD');
          }
          const version = await tx.billingOrganisationContractVersion.create({
            data: {
              contractId: contract.id,
              version: (latest?.version ?? 0) + 1,
              usageMarkupBps: params.usageMarkupBps,
              currency,
              paymentTermsDays: params.paymentTermsDays,
              effectiveFromMonth: params.effectiveFromMonth,
              createdByUserId: params.actor.userId ?? null,
              createdByEmail: actorEmail,
            },
          });
          await tx.adminAuditLog.create({
            data: {
              actorEmail,
              action: 'billing.contract_version_created',
              metadata: {
                contract_id: contract.id,
                contract_version_id: version.id,
                version: version.version,
                usage_markup_bps: version.usageMarkupBps,
              },
            },
          });
          return version;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isRetryable(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'BILLING_CONTRACT_VERSION_CREATE_FAILED');
}

async function activateInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    contractId: string;
    contractVersionId: string;
    services: NormalizedContractService[];
    actor: FinancialActor;
    now: Date;
  },
) {
  const actorEmail = await requireLifecycleActor(tx as PrismaClient, params.actor);
  const contract = await tx.billingOrganisationContract.findUnique({
    where: { id: params.contractId },
    include: {
      versions: {
        orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
        include: { serviceTerms: { include: { tariff: true, seatSubscription: true } } },
      },
    },
  });
  const version = contract?.versions.find((item) => item.id === params.contractVersionId);
  const currentVersion = contract?.versions.find((item) => item.serviceTerms.length > 0);
  if (!contract || !version) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_CONTRACT_VERSION_NOT_FOUND');
  }
  if (contract.status === BillingOrganisationContractStatus.TERMINATED) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_TERMINATED');
  }
  const previousTerms = currentVersion?.serviceTerms ?? [];
  const previousAssignmentIds = previousTerms.flatMap((term) =>
    term.tariffAssignmentId ? [term.tariffAssignmentId] : [],
  );
  const previousAssignments = previousAssignmentIds.length
    ? await tx.billingTariffAssignment.findMany({
        where: { id: { in: previousAssignmentIds } },
        select: {
          id: true,
          serviceId: true,
          tariffId: true,
          orgId: true,
          teamId: true,
          scope: true,
          scopeKey: true,
        },
      })
    : [];
  const previousAssignmentById = new Map(previousAssignments.map((row) => [row.id, row]));
  if (
    previousTerms.some((term) => {
      if (!term.tariffAssignmentId) return false;
      const assignment = previousAssignmentById.get(term.tariffAssignmentId);
      return (
        !assignment ||
        assignment.serviceId !== term.serviceId ||
        assignment.tariffId !== term.tariffId ||
        assignment.orgId !== contract.orgId ||
        assignment.teamId !== null ||
        assignment.scope !== BillingAssignmentScope.ORGANISATION ||
        assignment.scopeKey !== contract.orgId
      );
    })
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_ASSIGNMENT_DRIFT');
  }
  if (version.serviceTerms.length > 0) {
    if (currentVersion?.id !== version.id) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_VERSION_SUPERSEDED');
    }
    const requested = new Map(params.services.map((item) => [item.serviceId, item]));
    const matches =
      requested.size === version.serviceTerms.length &&
      version.serviceTerms.every(
        (term) => {
          const requestedTerm = requested.get(term.serviceId);
          if (!requestedTerm) return false;
          const normalized = contractSeatTerms(requestedTerm, version,
            { key: contractTariffKey(contract.id),
              name: `${contract.name} contract`.slice(0, 120) });
          return requestedTerm.amount === term.monthlyAmountMinor &&
            normalized.fixedSeatQuantity === term.fixedSeatQuantity &&
            normalized.tariff.monthlyChargeBasis === term.tariff.monthlyChargeBasis &&
            normalized.tariff.seatPolicy === term.tariff.seatPolicy &&
            normalized.tariff.seatChargeTiming === term.tariff.seatChargeTiming &&
            normalized.tariff.usagePaymentMode === term.tariff.usagePaymentMode &&
            term.tariff.markupBps === version.usageMarkupBps &&
            term.tariff.currency === version.currency;
        },
      );
    if (!matches) throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_VERSION_ACTIVE');
    return version;
  }
  if (version.effectiveFromMonth <= params.now.toISOString().slice(0, 7)) {
    throw new AppError('BAD_REQUEST', 409,
      'BILLING_CONTRACT_RETROACTIVE_TERMS_RECONCILIATION_REQUIRED');
  }
  if (currentVersion && currentVersion.effectiveFromMonth >= version.effectiveFromMonth) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_VERSION_SUPERSEDED');
  }

  const serviceIds = params.services.map((item) => item.serviceId);
  await lockStripeContractScopes(tx, contract.orgId, serviceIds);
  for (const serviceId of [...new Set([
    ...serviceIds, ...previousTerms.map((term) => term.serviceId),
  ])].sort()) await lockTariffHistoryService(tx, serviceId);
  const [serviceRows, teamOverride, checkout, subscription] = await Promise.all([
    tx.billingService.findMany({
      where: { id: { in: serviceIds }, active: true },
      select: { id: true, identifier: true, name: true },
    }),
    tx.billingTariffAssignment.findFirst({
      where: {
        orgId: contract.orgId,
        serviceId: { in: serviceIds },
        scope: BillingAssignmentScope.TEAM,
      },
      select: { id: true },
    }),
    tx.billingStripeCheckoutSession.findFirst({
      where: {
        orgId: contract.orgId,
        serviceId: { in: serviceIds },
        OR: [
          { status: { in: ['creating', 'open'] } },
          {
            status: 'complete',
            OR: [
              { subscription: { is: null } },
              {
                subscription: {
                  is: { status: { notIn: ['canceled', 'incomplete_expired'] } },
                },
              },
            ],
          },
        ],
      },
      select: { id: true },
    }),
    tx.billingStripeSubscription.findFirst({
      where: {
        orgId: contract.orgId,
        serviceId: { in: serviceIds },
        status: { notIn: ['canceled', 'incomplete_expired'] },
      },
      select: { id: true },
    }),
  ]);
  if (serviceRows.length !== serviceIds.length) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_SERVICE_NOT_FOUND');
  }
  if (teamOverride) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_TEAM_OVERRIDE_EXISTS');
  }
  if (checkout || subscription) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CONTRACT_STRIPE_CONFLICT');
  }

  const key = contractTariffKey(contract.id);
  const serviceById = new Map(serviceRows.map((row) => [row.id, row]));
  const commercialEffectiveAt = new Date(`${version.effectiveFromMonth}-01T00:00:00.000Z`);
  const createdTerms = [];
  for (const requested of params.services) {
    const service = serviceById.get(requested.serviceId);
    if (!service) throw new AppError('BAD_REQUEST', 400, 'BILLING_CONTRACT_SERVICE_NOT_FOUND');
    const { tariff: normalized, fixedSeatQuantity } = contractSeatTerms(requested,
      version, { key, name: `${contract.name} contract`.slice(0, 120) });
    const latest = await tx.billingTariff.findFirst({
      where: { serviceId: requested.serviceId, key },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const tariff = await tx.billingTariff.create({
      data: {
        serviceId: requested.serviceId,
        key,
        version: (latest?.version ?? 0) + 1,
        name: `${contract.name} contract`.slice(0, 120),
        mode: normalized.mode,
        collectionMode: normalized.collectionMode,
        markupBps: normalized.markupBps,
        monthlyAmountMinor: normalized.monthlyAmountMinor,
        monthlyChargeBasis: normalized.monthlyChargeBasis,
        seatPolicy: normalized.seatPolicy,
        seatChargeTiming: normalized.seatChargeTiming,
        usagePaymentMode: normalized.usagePaymentMode,
        currency: normalized.currency,
        isDefault: false,
        createdByUserId: params.actor.userId ?? null,
        createdByEmail: actorEmail,
      },
    });
    const term = await tx.billingContractServiceTerm.create({
        data: {
          contractVersionId: version.id,
          serviceId: requested.serviceId,
          tariffId: tariff.id,
          tariffAssignmentId: null,
          monthlyAmountMinor: requested.amount,
          fixedSeatQuantity,
        },
      });
    createdTerms.push({ ...term, tariff, service });
    await createManualSeatAgreement(tx, { serviceId: requested.serviceId,
      tariffId: tariff.id, termId: term.id, orgId: contract.orgId,
      monthlyChargeBasis: normalized.monthlyChargeBasis,
      seatPolicy: normalized.seatPolicy, seatChargeTiming: normalized.seatChargeTiming,
      amount: normalized.monthlyAmountMinor, currency: normalized.currency,
      fixedSeatQuantity, commercialEffectiveAt });
  }
  for (const previous of previousTerms) {
    if (previous.seatSubscription && !previous.seatSubscription.commercialEndsAt) {
      await tx.billingSeatSubscription.update({ where: { id: previous.seatSubscription.id },
        data: { commercialEndsAt: commercialEffectiveAt } });
    }
  }
  const selectedServices = new Set(serviceIds);
  for (const previous of previousTerms) {
    if (selectedServices.has(previous.serviceId) || !previous.tariffAssignmentId) continue;
    await appendTariffTermEvent(tx, {
      serviceId: previous.serviceId,
      source: BillingTariffSource.ORGANISATION,
      scopeKey: contract.orgId,
      effectiveFromMonth: version.effectiveFromMonth,
      tariffId: null,
      actorEmail,
      reason: 'contract_service_removed',
    });
  }
  await tx.billingOrganisationContract.update({
    where: { id: contract.id },
    data: {
      status: BillingOrganisationContractStatus.ACTIVE,
      activatedAt: contract.activatedAt ?? params.now,
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actorEmail,
      action: 'billing.contract_version_activated',
      metadata: {
        contract_id: contract.id,
        contract_version_id: version.id,
        service_ids: serviceIds,
        effective_from_month: version.effectiveFromMonth,
      },
    },
  });
  return { ...version, serviceTerms: createdTerms };
}

export async function activateBillingContractVersion(
  params: {
    contractId: string;
    contractVersionId: string;
    services: ContractServiceActivation[];
    actor: FinancialActor;
  },
  deps?: { prisma?: ContractClient; now?: () => Date },
) {
  const services = normalizeContractServices(params.services);
  const prisma = client(deps);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) =>
          activateInTransaction(tx, {
            ...params,
            services,
            now: deps?.now?.() ?? new Date(),
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isRetryable(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'BILLING_CONTRACT_ACTIVATION_FAILED');
}

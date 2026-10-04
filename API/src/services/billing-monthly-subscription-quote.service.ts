import {
  BillingAssignmentScope, BillingMonthlyChargeBasis, BillingSeatPolicy,
  type BillingSeatChargeTiming, type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { quoteMonthlySeatCharge } from './billing-seat-month-quote.service.js';

export type MonthlyChargeSource = { kind: 'stripe' | 'manual'; id: string };

type SeatAgreement = {
  id: string;
  stripeSubscriptionId: string | null;
  contractServiceTermId: string | null;
  serviceId: string;
  tariffId: string;
  orgId: string;
  teamId: string | null;
  scope: BillingAssignmentScope;
  seatPolicy: BillingSeatPolicy;
  seatChargeTiming: BillingSeatChargeTiming;
  unitAmountMinor: bigint;
  currency: string;
  activatedAt: Date;
  commercialEffectiveAt: Date;
  commercialEndsAt: Date | null;
  endedAt: Date | null;
  baselineCapturedAt: Date;
  baselineMemberCount: number | null;
  membershipIntervals: Array<{ id: string; userId: string; startsAt: Date;
    endsAt: Date | null; baseline: boolean }>;
  capacityRevisions: Array<{ id: string; quantity: number; effectiveAt: Date }>;
};

type FrozenTerms = {
  source: MonthlyChargeSource;
  serviceId: string;
  tariffId: string;
  orgId: string;
  teamId: string | null;
  scope: BillingAssignmentScope;
  chargeBasis: BillingMonthlyChargeBasis;
  seatPolicy: BillingSeatPolicy | null;
  seatChargeTiming: BillingSeatChargeTiming | null;
  unitAmountMinor: bigint;
  currency: string;
  agreement: SeatAgreement | null;
  contractId?: string;
  contractVersionId?: string;
};

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

async function loadFrozenTerms(source: MonthlyChargeSource, prisma: PrismaClient): Promise<FrozenTerms> {
  if (source.kind === 'stripe') {
    const row = await prisma.billingStripeSubscription.findUnique({
      where: { id: source.id },
      include: { tariff: true, seatSubscription: {
        include: { membershipIntervals: true, capacityRevisions: true },
      } },
    });
    if (!row) hold('BILLING_MONTHLY_SOURCE_NOT_FOUND');
    return { source, serviceId: row.serviceId, tariffId: row.tariffId,
      orgId: row.orgId, teamId: row.teamId, scope: row.scope,
      chargeBasis: row.tariff.monthlyChargeBasis, seatPolicy: row.tariff.seatPolicy,
      seatChargeTiming: row.tariff.seatChargeTiming,
      unitAmountMinor: row.tariff.monthlyAmountMinor, currency: row.tariff.currency,
      agreement: row.seatSubscription };
  }
  const row = await prisma.billingContractServiceTerm.findUnique({
    where: { id: source.id },
    include: { tariff: true, contractVersion: {
      include: { contract: { select: { orgId: true } } },
    }, seatSubscription: {
      include: { membershipIntervals: true, capacityRevisions: true },
    } },
  });
  if (!row) hold('BILLING_MONTHLY_SOURCE_NOT_FOUND');
  if (row.tariff.monthlyAmountMinor !== row.monthlyAmountMinor ||
    row.tariff.currency !== row.contractVersion.currency) {
    hold('BILLING_MONTHLY_SOURCE_DRIFT');
  }
  return { source, serviceId: row.serviceId, tariffId: row.tariffId,
    orgId: row.contractVersion.contract.orgId, teamId: null,
    scope: BillingAssignmentScope.ORGANISATION,
    chargeBasis: row.tariff.monthlyChargeBasis, seatPolicy: row.tariff.seatPolicy,
    seatChargeTiming: row.tariff.seatChargeTiming,
    unitAmountMinor: row.monthlyAmountMinor, currency: row.tariff.currency,
    agreement: row.seatSubscription, contractId: row.contractVersion.contractId,
    contractVersionId: row.contractVersionId };
}

export async function quoteSubscriptionMonthlyCharge(
  params: { source: MonthlyChargeSource; billingMonth: string },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.billingMonth)) {
    hold('BILLING_MONTH_INVALID');
  }
  const terms = await loadFrozenTerms(params.source, prisma);
  if (terms.contractId) {
    const effective = await prisma.billingOrganisationContractVersion.findFirst({
      where: { contractId: terms.contractId,
        effectiveFromMonth: { lte: params.billingMonth } },
      orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
      select: { id: true },
    });
    if (effective?.id !== terms.contractVersionId) hold('BILLING_MONTHLY_SOURCE_NOT_EFFECTIVE');
  }
  if (terms.chargeBasis === BillingMonthlyChargeBasis.FLAT) {
    if (terms.agreement || terms.seatPolicy || terms.seatChargeTiming) {
      hold('BILLING_MONTHLY_SOURCE_DRIFT');
    }
    return { source: terms.source, serviceId: terms.serviceId, tariffId: terms.tariffId,
      organisationId: terms.orgId, teamId: terms.teamId, scope: terms.scope,
      agreementId: null, billingMonth: params.billingMonth,
      chargeBasis: terms.chargeBasis, seatPolicy: null, seatChargeTiming: null,
      amountMinor: terms.unitAmountMinor, unitAmountMinor: terms.unitAmountMinor,
      uniqueHumanSeats: null, seatMilliseconds: null, monthMilliseconds: null,
      currency: terms.currency, baselineCapturedAt: null, baselineMemberCount: null,
      intervals: [], capacityRevisions: [], evidenceIds: [] };
  }
  const agreement = terms.agreement;
  if (!agreement || !terms.seatPolicy || !terms.seatChargeTiming ||
    agreement.baselineMemberCount === null ||
    agreement.baselineCapturedAt.getTime() !== agreement.activatedAt.getTime() ||
    agreement.serviceId !== terms.serviceId || agreement.tariffId !== terms.tariffId ||
    agreement.orgId !== terms.orgId || agreement.teamId !== terms.teamId ||
    agreement.scope !== terms.scope || agreement.seatPolicy !== terms.seatPolicy ||
    agreement.seatChargeTiming !== terms.seatChargeTiming ||
    agreement.unitAmountMinor !== terms.unitAmountMinor ||
    agreement.currency !== terms.currency ||
    (terms.source.kind === 'stripe'
      ? agreement.stripeSubscriptionId !== terms.source.id || agreement.contractServiceTermId !== null
      : agreement.contractServiceTermId !== terms.source.id || agreement.stripeSubscriptionId !== null)) {
    hold('BILLING_SEAT_EVIDENCE_UNRESOLVED');
  }
  const baselineRows = agreement.membershipIntervals.filter((row) => row.baseline &&
    row.startsAt.getTime() === agreement.activatedAt.getTime());
  if (agreement.seatPolicy === BillingSeatPolicy.AUTOMATIC &&
    baselineRows.length !== agreement.baselineMemberCount) {
    hold('BILLING_SEAT_EVIDENCE_UNRESOLVED');
  }
  const quote = quoteMonthlySeatCharge({ billingMonth: params.billingMonth,
    seatPolicy: agreement.seatPolicy, seatChargeTiming: agreement.seatChargeTiming,
    unitAmountMinor: agreement.unitAmountMinor, activatedAt: agreement.activatedAt,
    commercialEffectiveAt: agreement.commercialEffectiveAt,
    commercialEndsAt: agreement.commercialEndsAt, endedAt: agreement.endedAt,
    membershipIntervals: agreement.membershipIntervals,
    capacityRevisions: agreement.capacityRevisions });
  return { source: terms.source, serviceId: terms.serviceId, tariffId: terms.tariffId,
    organisationId: terms.orgId, teamId: terms.teamId, scope: terms.scope,
    agreementId: agreement.id, billingMonth: params.billingMonth,
    chargeBasis: terms.chargeBasis, seatPolicy: terms.seatPolicy,
    seatChargeTiming: terms.seatChargeTiming,
    amountMinor: quote.amountMinor, unitAmountMinor: quote.unitAmountMinor,
    uniqueHumanSeats: quote.uniqueHumanSeats,
    seatMilliseconds: quote.seatMilliseconds,
    monthMilliseconds: quote.monthMilliseconds, currency: terms.currency,
    baselineCapturedAt: agreement.baselineCapturedAt,
    baselineMemberCount: agreement.baselineMemberCount,
    intervals: agreement.membershipIntervals.filter((row) => quote.evidenceIds.includes(row.id)),
    capacityRevisions: agreement.capacityRevisions.filter((row) => quote.evidenceIds.includes(row.id)),
    evidenceIds: quote.evidenceIds };
}

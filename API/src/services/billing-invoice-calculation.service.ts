import { createHash } from 'node:crypto';

import {
  BillingInvoiceStatus,
  BillingMonthlyChargeBasis,
  BillingOrganisationContractStatus,
  BillingUsagePaymentMode,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { collectContractFundingEvidence } from './billing-contract-funding-evidence.service.js';
import { writeInvoiceFinancialAllocations } from './billing-invoice-financial-allocation.service.js';
import { collectManualInvoicePaidCohort, writeManualInvoicePaidCohort } from
  './billing-invoice-paid-receipt-cohort.service.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { fetchVerifiedLedgerPaidReceiptSet } from
  './billing-ledger-paid-receipt-proof.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { meteringIsComplete, type FetchMeteringUsage } from './billing-metering.types.js';
import {
  addBillingDecimals,
  majorAmountToMinorRounded,
  minorAmountToMajor,
} from './billing-money.service.js';
import { rateMeteringTotal } from './billing-rating.service.js';
import { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';
import { allocateInvoiceTaxMinor, assertInvoiceTaxTerms,
  type BillingInvoiceTaxTerms } from './billing-invoice-tax.service.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MICROCREDITS_PER_USD_MINOR = 10_000_000n;

type Actor = { userId?: string | null; email: string };

type CalculationDeps = {
  prisma?: PrismaClient;
  fetchMetering?: FetchMeteringUsage;
  collectFunding?: typeof collectContractFundingEvidence;
  quoteMonthly?: typeof quoteSubscriptionMonthlyCharge;
  discoverTeams?: typeof fetchLedgerHistoricalBillingTeams;
  fetchPaidReceiptSet?: typeof fetchVerifiedLedgerPaidReceiptSet;
  now?: () => Date;
};

export function closedBillingMonthPeriod(
  billingMonth: string,
  now: Date,
): { startsAt: Date; endsAt: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(billingMonth);
  if (!match) throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  const startsAt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const endsAt = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  if (endsAt > now) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_MONTH_NOT_CLOSED');
  }
  return { startsAt, endsAt };
}

function profileSnapshot(profile: {
  id: string;
  legalName: string;
  billingEmail: string;
  taxIdentifier: string | null;
  [key: string]: unknown;
}) {
  return {
    profile_id: profile.id,
    legal_name: profile.legalName,
    billing_email: profile.billingEmail,
    tax_identifier: profile.taxIdentifier,
  };
}

function issuerSnapshot(profile: {
  id: string;
  legalName: string;
  tradingName: string | null;
  billingEmail: string;
  address: Prisma.JsonValue;
  taxIdentifier: string | null;
  companyRegistrationNumber: string | null;
}) {
  return {
    ...profileSnapshot(profile),
    trading_name: profile.tradingName,
    address: profile.address,
    company_registration_number: profile.companyRegistrationNumber,
  };
}

function buyerSnapshot(profile: {
  id: string;
  legalName: string;
  billingEmail: string;
  billingAddress: Prisma.JsonValue;
  taxIdentifier: string | null;
  purchaseOrderReference: string | null;
}) {
  return {
    ...profileSnapshot(profile),
    billing_address: profile.billingAddress,
    purchase_order_reference: profile.purchaseOrderReference,
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

export async function calculateBillingContractInvoice(
  params: {
    contractId: string;
    issuerProfileId: string;
    billingMonth: string;
    taxTerms: BillingInvoiceTaxTerms;
    actor: Actor;
  },
  deps?: CalculationDeps,
) {
  const now = deps?.now?.() ?? new Date();
  const taxTerms = assertInvoiceTaxTerms(params.taxTerms);
  const period = closedBillingMonthPeriod(params.billingMonth, now);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const contract = await prisma.billingOrganisationContract.findFirst({
    where: {
      id: params.contractId,
      status: { in: [BillingOrganisationContractStatus.ACTIVE,
        BillingOrganisationContractStatus.TERMINATED] },
    },
    include: {
      versions: {
        where: {
          effectiveFromMonth: { lte: params.billingMonth },
          serviceTerms: { some: {} },
        },
        orderBy: [{ effectiveFromMonth: 'desc' }, { version: 'desc' }],
        take: 1,
        include: {
          serviceTerms: {
            orderBy: { serviceId: 'asc' },
            include: { service: true, tariff: true },
          },
        },
      },
    },
  });
  const version = contract?.versions[0];
  if (!contract || !version) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_CONTRACT_VERSION_NOT_EFFECTIVE');
  }
  const [issuer, buyer] = await Promise.all([
    prisma.billingInvoiceIssuerProfile.findFirst({
      where: { id: params.issuerProfileId, active: true },
    }),
    prisma.billingOrganisationInvoiceProfile.findUnique({
      where: { orgId: contract.orgId },
    }),
  ]);
  if (!issuer) throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_ISSUER_NOT_FOUND');
  if (!buyer) throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_BUYER_PROFILE_REQUIRED');

  const fetchMetering = deps?.fetchMetering ?? fetchLedgerMeteringUsage;
  const collectFunding = deps?.collectFunding ?? collectContractFundingEvidence;
  const calculated = await Promise.all(
    version.serviceTerms.map(async (term) => {
      if (
        term.tariff.mode !== 'CUSTOM' ||
        term.tariff.collectionMode !== 'MANUAL' ||
        term.tariff.markupBps !== version.usageMarkupBps ||
        term.tariff.currency !== version.currency ||
        term.monthlyAmountMinor !== term.tariff.monthlyAmountMinor
      ) {
        throw new AppError('INTERNAL', 500, 'BILLING_CONTRACT_TARIFF_DRIFT');
      }
      const [metering, funding] = await Promise.all([
        fetchMetering({
          product: term.service.identifier,
          organisationId: contract.orgId,
          teamId: null,
          billingMonth: params.billingMonth,
          groupBy: 'service',
        }),
        collectFunding(
          {
            serviceId: term.serviceId,
            tariffId: term.tariffId,
            organisationId: contract.orgId,
            billingMonth: params.billingMonth,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
          },
          { prisma },
        ),
      ]);
      if (!meteringIsComplete(metering.billingCompleteness)) {
        throw new AppError('INTERNAL', 409, 'LEDGER_METERING_UNRESOLVED_PAID_USAGE');
      }
      const usageTotal = term.tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID
        ? '0' : rateMeteringTotal({
          usage: metering, product: term.service.identifier,
          currency: version.currency,
          terms: { mode: 'custom', markupBps: version.usageMarkupBps },
        }).total;
      if (term.tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID &&
        funding.credits.length > 0) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PREPAID_CREDIT_CONFLICT');
      }
      const monthlyQuote = await (deps?.quoteMonthly ?? quoteSubscriptionMonthlyCharge)({
        source: { kind: 'manual', id: term.id }, billingMonth: params.billingMonth,
      }, { prisma, now: () => now });
      if (monthlyQuote.chargeBasis !== term.tariff.monthlyChargeBasis ||
        monthlyQuote.currency !== version.currency ||
        monthlyQuote.tariffId !== term.tariffId ||
        monthlyQuote.serviceId !== term.serviceId) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_MONTHLY_QUOTE_DRIFT');
      }
      const monthlyAmountMinor = monthlyQuote.amountMinor;
      const total = addBillingDecimals(
        minorAmountToMajor(monthlyAmountMinor.toString(), version.currency),
        usageTotal,
      );
      const amountMinor = majorAmountToMinorRounded(total, version.currency);
      if (amountMinor < 0n || amountMinor > MAX_INT64) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_SERVICE_TOTAL_INVALID');
      }
      const usageMinor = amountMinor - monthlyAmountMinor;
      if (usageMinor < 0n) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_USAGE_TOTAL_INVALID');
      }
      const paidCohort = usageMinor > 0n ?
        await collectManualInvoicePaidCohort({ serviceId: term.serviceId,
          product: term.service.identifier, orgId: contract.orgId,
          billingMonth: params.billingMonth }, {
          discoverTeams: deps?.discoverTeams,
          fetchPaidReceiptSet: deps?.fetchPaidReceiptSet,
        }) : [];
      return {
        serviceId: term.serviceId,
        serviceIdentifier: term.service.identifier,
        serviceName: term.service.name,
        amountMinor,
        monthlyAmountMinor,
        usageMinor,
        paidCohort,
        seatQuote: term.tariff.monthlyChargeBasis === BillingMonthlyChargeBasis.PER_SEAT
          ? monthlyQuote : null,
        credits: funding.credits,
        addons: funding.addons,
        snapshot: {
          service_id: term.serviceId,
          cursor: metering.snapshot.cursor,
          sha256: metering.snapshot.sha256,
          captured_at: metering.snapshot.capturedAt,
        },
      };
    }),
  );
  calculated.sort((left, right) => Buffer.compare(Buffer.from(left.serviceIdentifier), Buffer.from(right.serviceIdentifier)));
  const subtotalMinor = calculated.reduce((total, line) => total + line.amountMinor, 0n);
  const taxByService = allocateInvoiceTaxMinor(calculated.map((line) => ({
    id: line.serviceId, netMinor: line.amountMinor,
  })), taxTerms);
  const taxAmountMinor = [...taxByService.values()].reduce((sum, value) => sum + value, 0n);
  const creditEvidence = calculated.flatMap((line) => line.credits);
  const creditsAppliedMicrocredits = creditEvidence.reduce(
    (total, reference) => total + reference.creditsAppliedMicrocredits,
    0n,
  );
  if (creditsAppliedMicrocredits > 0n && version.currency !== 'USD') {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_CURRENCY_MISMATCH');
  }
  const creditsAppliedMinor =
    (creditsAppliedMicrocredits + MICROCREDITS_PER_USD_MINOR / 2n) / MICROCREDITS_PER_USD_MINOR;
  const addonEvidence = calculated
    .flatMap((line) => line.addons)
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.offerKey}:${left.scope}:${left.subscriptionId}`),
        Buffer.from(`${right.offerKey}:${right.scope}:${right.subscriptionId}`),
      ),
    );
  if (subtotalMinor + taxAmountMinor > MAX_INT64) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_TOTAL_INVALID');
  }
  if (creditsAppliedMinor > subtotalMinor) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_EXCEEDS_TOTAL');
  }
  const issuerData = issuerSnapshot(issuer);
  const buyerData = buyerSnapshot(buyer);
  const calculationDigest = digest({
    contract_id: contract.id,
    contract_version_id: version.id,
    billing_month: params.billingMonth,
    currency: version.currency,
    issuer: issuerData,
    buyer: buyerData,
    tax: { treatment: taxTerms.treatment, rate_bps: taxTerms.rateBps,
      legal_basis: taxTerms.legalBasis, amount_minor: taxAmountMinor.toString() },
    lines: calculated.map((line) => ({
      service_id: line.serviceId,
      amount_minor: line.amountMinor.toString(),
      seat_quote: line.seatQuote ? {
        agreement_id: line.seatQuote.agreementId,
        amount_minor: line.seatQuote.amountMinor.toString(),
        seat_milliseconds: line.seatQuote.seatMilliseconds?.toString(),
        evidence_ids: line.seatQuote.evidenceIds,
      } : null,
      snapshot: line.snapshot,
      paid_cohort: line.paidCohort.map(({ scope, proof }) => ({
        team_id: scope.teamId, count: proof.paid_receipt_count,
        sha256: proof.paid_receipt_sha256,
      })),
    })),
    credit_settlements: creditEvidence.map((reference) => ({
      account_id: reference.accountId,
      team_id: reference.teamId,
      settlement_id: reference.settlementId,
      adjustment_id: reference.adjustmentId,
      credits_applied_microcredits: reference.creditsAppliedMicrocredits.toString(),
    })),
    separately_billed_addons: addonEvidence.map((addon) => ({
      subscription_id: addon.subscriptionId,
      offer_id: addon.offerId,
      offer_version: addon.offerVersion,
      catalog_id: addon.catalogId,
      amount_minor: addon.monthlyAmountMinor.toString(),
      currency: addon.currency,
      scope: addon.scope,
    })),
    credits_applied_minor: creditsAppliedMinor.toString(),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`uoa-invoice-revision:${contract.id}:${params.billingMonth}`}, 0))::text AS "locked"`,
          );
          const existing = await tx.billingInvoice.findFirst({
            where: {
              contractId: contract.id,
              contractVersionId: version.id,
              billingMonth: params.billingMonth,
              issuerProfileId: issuer.id,
              buyerProfileId: buyer.id,
              calculationDigest,
              status: BillingInvoiceStatus.DRAFT,
            },
            include: {
              lines: { orderBy: { position: 'asc' } },
              addonLines: { orderBy: { position: 'asc' } },
              paymentEvents: true,
              issuerProfile: { select: { active: true } },
              _count: { select: { creditSettlementRefs: true } },
            },
          });
          if (existing) {
            const frozenCount = await tx.billingInvoiceLineFinancialAllocation.count({
              where: { invoiceId: existing.id },
            });
            if (frozenCount === 0) {
              await writeInvoiceFinancialAllocations(tx, existing, calculated.map((line) => ({
                serviceId: line.serviceId,
                subscriptionMinor: line.monthlyAmountMinor,
                usageMinor: line.usageMinor,
                taxMinor: taxByService.get(line.serviceId) ?? 0n,
              })));
            }
            for (const line of calculated) {
              await writeManualInvoicePaidCohort(tx, existing, {
                id: line.serviceId, product: line.serviceIdentifier,
                usageMinor: line.usageMinor, proofs: line.paidCohort,
              });
            }
            return existing;
          }
          const latest = await tx.billingInvoice.findFirst({
            where: { contractId: contract.id, billingMonth: params.billingMonth },
            orderBy: { revision: 'desc' },
            select: { revision: true },
          });
          const invoice = await tx.billingInvoice.create({
            data: {
              orgId: contract.orgId,
              contractId: contract.id,
              contractVersionId: version.id,
              issuerProfileId: issuer.id,
              buyerProfileId: buyer.id,
              billingMonth: params.billingMonth,
              revision: (latest?.revision ?? 0) + 1,
              currency: version.currency,
              subtotalMinor,
              taxAmountMinor,
              taxTreatment: taxTerms.treatment,
              taxRateBps: taxTerms.rateBps,
              taxLegalBasis: taxTerms.legalBasis,
              totalMinor: subtotalMinor + taxAmountMinor,
              creditsAppliedMinor,
              issuerSnapshot: issuerData,
              buyerSnapshot: buyerData,
              calculationDigest,
              createdByUserId: params.actor.userId ?? null,
              createdByEmail: params.actor.email,
              lines: {
                create: calculated.map((line, index) => ({
                  serviceId: line.serviceId,
                  serviceIdentifier: line.serviceIdentifier,
                  serviceName: line.serviceName,
                  amountMinor: line.amountMinor,
                  currency: version.currency,
                  position: index + 1,
                })),
              },
              meteringRefs: {
                create: calculated.map((line) => ({
                  serviceId: line.serviceId,
                  ledgerSnapshotCursor: line.snapshot.cursor,
                  ledgerSnapshotSha256: line.snapshot.sha256,
                  capturedAt: new Date(line.snapshot.captured_at),
                })),
              },
              creditSettlementRefs: {
                create: creditEvidence.map((reference) => ({
                  serviceId: reference.serviceId,
                  settlementId: reference.settlementId,
                  adjustmentId: reference.adjustmentId,
                  creditsAppliedMicrocredits: reference.creditsAppliedMicrocredits,
                })),
              },
              addonLines: {
                create: addonEvidence.map((addon, index) => ({
                  serviceId: addon.serviceId,
                  serviceIdentifier: addon.serviceIdentifier,
                  serviceName: addon.serviceName,
                  addonSubscriptionId: addon.subscriptionId,
                  offerId: addon.offerId,
                  offerVersion: addon.offerVersion,
                  catalogId: addon.catalogId,
                  offerKey: addon.offerKey,
                  offerName: addon.offerName,
                  monthlyAmountMinor: addon.monthlyAmountMinor,
                  currency: addon.currency,
                  scope: addon.scope,
                  position: index + 1,
                })),
              },
            },
            include: {
              lines: { orderBy: { position: 'asc' } },
              addonLines: { orderBy: { position: 'asc' } },
              paymentEvents: true,
              issuerProfile: { select: { active: true } },
              _count: { select: { creditSettlementRefs: true } },
            },
          });
          await writeInvoiceFinancialAllocations(tx, invoice, calculated.map((line) => ({
            serviceId: line.serviceId,
                subscriptionMinor: line.monthlyAmountMinor,
                usageMinor: line.usageMinor,
                taxMinor: taxByService.get(line.serviceId) ?? 0n,
          })));
          for (const line of calculated) {
            await writeManualInvoicePaidCohort(tx, invoice, {
              id: line.serviceId, product: line.serviceIdentifier,
              usageMinor: line.usageMinor, proofs: line.paidCohort,
            });
          }
          await tx.adminAuditLog.create({
            data: {
              actorEmail: params.actor.email,
              action: 'billing.invoice_calculated',
              metadata: {
                invoice_id: invoice.id,
                contract_id: contract.id,
                billing_month: params.billingMonth,
                revision: invoice.revision,
              },
            },
          });
          return invoice;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isRetryable(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_CALCULATION_FAILED');
}

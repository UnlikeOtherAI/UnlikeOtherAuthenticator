import { createHash } from 'node:crypto';

import {
  BillingAdjustmentKind,
  BillingInvoiceStatus,
  BillingOrganisationContractStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { listApplicableOrganisationInvoiceAdjustments } from './billing-commercial-adjustment.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import type { FetchMeteringUsage } from './billing-metering.types.js';
import {
  addBillingDecimals,
  majorAmountToMinorRounded,
  minorAmountToMajor,
} from './billing-money.service.js';
import { rateMeteringTotal } from './billing-rating.service.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;

type Actor = { userId?: string | null; email: string };

type CalculationDeps = {
  prisma?: PrismaClient;
  fetchMetering?: FetchMeteringUsage;
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
    actor: Actor;
  },
  deps?: CalculationDeps,
) {
  const now = deps?.now?.() ?? new Date();
  const period = closedBillingMonthPeriod(params.billingMonth, now);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const contract = await prisma.billingOrganisationContract.findFirst({
    where: {
      id: params.contractId,
      status: BillingOrganisationContractStatus.ACTIVE,
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
      const [metering, adjustments] = await Promise.all([
        fetchMetering({
          product: term.service.identifier,
          organisationId: contract.orgId,
          teamId: null,
          billingMonth: params.billingMonth,
          groupBy: 'service',
        }),
        listApplicableOrganisationInvoiceAdjustments(
          {
            serviceId: term.serviceId,
            organisationId: contract.orgId,
            startsAt: period.startsAt,
            endsAt: period.endsAt,
          },
          { prisma },
        ),
      ]);
      const rated = rateMeteringTotal({
        usage: metering,
        product: term.service.identifier,
        currency: version.currency,
        terms: { mode: 'custom', markupBps: version.usageMarkupBps },
      });
      let total = addBillingDecimals(
        minorAmountToMajor(term.monthlyAmountMinor.toString(), version.currency),
        rated.total,
      );
      let creditsAppliedMinor = 0n;
      const adjustmentEvidence: Array<{
        id: string;
        kind: string;
        amount_minor: string;
        scope: string;
        scope_key: string;
      }> = [];
      for (const adjustment of adjustments) {
        if (adjustment.currency !== version.currency) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CURRENCY_MISMATCH');
        }
        adjustmentEvidence.push({
          id: adjustment.id,
          kind: adjustment.kind,
          amount_minor: adjustment.amountMinor.toString(),
          scope: adjustment.scope,
          scope_key: adjustment.scopeKey,
        });
        if (adjustment.kind === BillingAdjustmentKind.CREDIT) {
          creditsAppliedMinor += adjustment.amountMinor;
        } else {
          total = addBillingDecimals(
            total,
            minorAmountToMajor(adjustment.amountMinor.toString(), version.currency),
          );
        }
      }
      const amountMinor = majorAmountToMinorRounded(total, version.currency);
      if (amountMinor < 0n || amountMinor > MAX_INT64) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_SERVICE_TOTAL_INVALID');
      }
      return {
        serviceId: term.serviceId,
        serviceIdentifier: term.service.identifier,
        serviceName: term.service.name,
        amountMinor,
        creditsAppliedMinor,
        adjustmentEvidence,
        snapshot: {
          service_id: term.serviceId,
          cursor: metering.snapshot.cursor,
          sha256: metering.snapshot.sha256,
          captured_at: metering.snapshot.capturedAt,
        },
      };
    }),
  );
  calculated.sort((left, right) => left.serviceIdentifier.localeCompare(right.serviceIdentifier));
  const subtotalMinor = calculated.reduce((total, line) => total + line.amountMinor, 0n);
  const creditsAppliedMinor = calculated.reduce(
    (total, line) => total + line.creditsAppliedMinor,
    0n,
  );
  if (subtotalMinor > MAX_INT64) {
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
    lines: calculated.map((line) => ({
      service_id: line.serviceId,
      amount_minor: line.amountMinor.toString(),
      adjustments: line.adjustmentEvidence,
      snapshot: line.snapshot,
    })),
    credits_applied_minor: creditsAppliedMinor.toString(),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
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
            include: { lines: { orderBy: { position: 'asc' } }, paymentEvents: true },
          });
          if (existing) return existing;
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
              taxAmountMinor: 0n,
              totalMinor: subtotalMinor,
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
            },
            include: { lines: { orderBy: { position: 'asc' } }, paymentEvents: true },
          });
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

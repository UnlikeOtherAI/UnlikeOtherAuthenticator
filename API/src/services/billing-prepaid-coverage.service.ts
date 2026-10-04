import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { meteringIsComplete, type NormalizedMeteringUsage } from './billing-metering.types.js';

function scaled(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
    throw new AppError('INTERNAL', 409, 'PREPAID_LEDGER_COST_INVALID');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

/** A prepaid month cannot close while a paid dispatch is unresolved or unfunded. */
export async function assertPrepaidUsageCovered(params: {
  usage: NormalizedMeteringUsage;
  serviceId: string;
  product: string;
  organisationId: string;
  teamId: string | null;
  billingMonth: string;
}, prisma: PrismaClient): Promise<void> {
  if (!meteringIsComplete(params.usage.billingCompleteness) ||
    params.usage.scope.organizationId !== params.organisationId ||
    params.usage.scope.teamId !== params.teamId ||
    params.usage.scope.month !== params.billingMonth) {
    throw new AppError('INTERNAL', 409, 'PREPAID_LEDGER_USAGE_UNRESOLVED');
  }
  const rows = await prisma.billingPrepaidReservation.findMany({
    where: { serviceId: params.serviceId, orgId: params.organisationId,
      billingMonth: params.billingMonth,
      ...(params.teamId ? { teamId: params.teamId } : {}) },
    select: { status: true, rawCostActual: true, currency: true },
  });
  if (rows.some((row) => row.status === 'ACTIVE' ||
    (row.status === 'SETTLED' && (row.rawCostActual === null || row.currency !== 'USD')))) {
    throw new AppError('INTERNAL', 409, 'PREPAID_RECEIPTS_UNRESOLVED');
  }
  const ledgerCost = params.usage.lines.filter((line) =>
    line.billingProduct === params.product && line.billingDisposition === 'paid')
    .reduce((sum, line) => {
      if (line.selectedProviderCost === null || line.currency !== 'USD') {
        throw new AppError('INTERNAL', 409, 'PREPAID_LEDGER_COST_INVALID');
      }
      return sum + scaled(line.selectedProviderCost);
    }, 0n);
  const settledCost = rows.reduce((sum, row) => sum +
    (row.status === 'SETTLED' && row.rawCostActual ? scaled(row.rawCostActual.toFixed(18)) : 0n), 0n);
  if (ledgerCost !== settledCost) {
    throw new AppError('INTERNAL', 409, 'PREPAID_RECEIPT_COVERAGE_MISMATCH');
  }
}

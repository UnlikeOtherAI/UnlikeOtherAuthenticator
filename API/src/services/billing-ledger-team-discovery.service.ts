import type { fetchLedgerRawUsage } from './billing-ledger-collector.service.js';
import { fetchLedgerRawUsage as collectRaw } from './billing-ledger-collector.service.js';
import { LedgerMeteringTeamUsageSchema } from './billing-ledger-metering-schema.service.js';
import { meteringIsComplete } from './billing-metering.types.js';
import { AppError } from '../utils/errors.js';

type RawResponse = Awaited<ReturnType<typeof fetchLedgerRawUsage>>;

function period(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_MONTH_INVALID');
  }
  const start = new Date(`${month}-01T00:00:00.000Z`);
  return { startsAt: start.toISOString(), endsAt: new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString() };
}

export function parseHistoricalBillingTeams(
  response: RawResponse,
  expected: { product: string; organisationId: string; billingMonth: string },
): { teamIds: string[]; snapshot: { id: string; cursor: string;
  capturedAt: string; sha256: string } } {
  const expectedPeriod = period(expected.billingMonth);
  const result = LedgerMeteringTeamUsageSchema.safeParse(response.value);
  if (!result.success) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_TEAM_RESPONSE_INVALID');
  }
  const usage = result.data;
  if (usage.product !== expected.product ||
    usage.scope.organizationId !== expected.organisationId ||
    usage.scope.teamId !== null || usage.scope.userId !== null ||
    usage.scope.month !== expected.billingMonth ||
    usage.scope.startsAt !== expectedPeriod.startsAt ||
    usage.scope.endsAt !== expectedPeriod.endsAt ||
    usage.snapshot.cursor !== usage.snapshot.id) {
    throw new AppError('INTERNAL', 502, 'LEDGER_METERING_TEAM_SCOPE_MISMATCH');
  }
  if (!meteringIsComplete(usage.billingCompleteness)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_LEDGER_COVERAGE_UNRESOLVED');
  }
  if (usage.breakdown.some((row) => row.billingProduct !== expected.product)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_TEAM_PRODUCT_MISMATCH');
  }
  if (usage.breakdown.some((row) => row.billingDisposition === 'paid' &&
    row.dimension === null)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_TEAM_ATTRIBUTION_MISSING');
  }
  return {
    teamIds: [...new Set(usage.breakdown.map((row) => row.dimension)
      .filter((id): id is string => id !== null))].sort(),
    snapshot: { id: usage.snapshot.id, cursor: usage.snapshot.cursor,
      capturedAt: usage.snapshot.capturedAt, sha256: response.sha256 },
  };
}

export async function fetchLedgerHistoricalBillingTeams(
  params: { product: string; organisationId: string; billingMonth: string },
  deps?: { fetchRaw?: typeof fetchLedgerRawUsage },
): Promise<ReturnType<typeof parseHistoricalBillingTeams>> {
  const response = await (deps?.fetchRaw ?? collectRaw)({
    ...params, teamId: null, groupBy: 'team',
  });
  return parseHistoricalBillingTeams(response, params);
}

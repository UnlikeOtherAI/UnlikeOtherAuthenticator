import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale, BillingTeamRecordedUsageV1, BillingTeamRetainedCreditsV1 }
  from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { billingCreditAmount } from './billing-credit-display.service.js';
import { billingTeamCopy } from './billing-team-copy.catalog.js';
import { matchUoaPaidReceiptSet, type LedgerPaidReceiptSet, type PaidReceiptScope }
  from './billing-ledger-paid-receipt-proof.service.js';
import { meteringIsComplete, type NormalizedMeteringUsage } from './billing-metering.types.js';

type Reader = PrismaClient | Prisma.TransactionClient;
export function billingTeamSourceRef(orgId: string, teamId: string, accountId: string): string {
  return `tbs_${createHash('sha256').update(JSON.stringify(['team-billing-source:v1', orgId, teamId, accountId])).digest('hex')}`;
}
function hold(): never { throw new AppError('BAD_REQUEST', 409, 'BILLING_TEAM_RECORDS_RECONCILIATION_REQUIRED'); }

/** Captured TEAM rows only. No current ORG wallet lookup, upsert or consent data. */
export async function readTeamRetainedCredits(reader: Reader, orgId: string, teamId: string,
  now: Date, locale?: BillingCustomerLocale): Promise<BillingTeamRetainedCreditsV1> {
  const rows = await reader.billingCreditAccount.findMany({ where: { orgId, teamId, scope: 'TEAM' },
    take: 101, orderBy: { id: 'asc' }, select: { id: true, accountId: true, balanceMicrocredits: true,
      currency: true, updatedAt: true, account: { select: { livemode: true } } } });
  if (rows.length > 100 || rows.some(row => row.currency !== 'USD')) hold();
  const copy = billingTeamCopy(locale);
  return { as_of: now.toISOString(), records: rows.map(row => ({ record_id: row.id,
    source_ref: billingTeamSourceRef(orgId, teamId, row.accountId), mode: row.account.livemode ? 'live' : 'sandbox',
    label: row.account.livemode ? copy.live : copy.sandbox,
    recorded_balance: billingCreditAmount(row.balanceMicrocredits, locale), recorded_at: row.updatedAt.toISOString() })) };
}

type CapturedRow = { dispatch_id: string; receipt_id: string; rated: bigint; currency: string;
  account_id: string | null; livemode: boolean | null; valid: boolean; waived: bigint | null; exception_valid: boolean };

/** Immutable paid receipt attribution, grouped by captured account AND mode.
 * This is gross recorded usage/waiver, not a collectible bill or wallet balance. */
export async function readTeamRecordedUsage(reader: Reader, scope: PaidReceiptScope,
  usage: NormalizedMeteringUsage, proof: LedgerPaidReceiptSet,
  locale?: BillingCustomerLocale): Promise<BillingTeamRecordedUsageV1> {
  if (!meteringIsComplete(usage.billingCompleteness) || proof.unresolved_paid_attempts !== '0' ||
    !proof.snapshot.immutable || proof.scope.billing_product !== scope.product ||
    proof.scope.organization_id !== scope.organisationId || proof.scope.team_id !== scope.teamId ||
    proof.scope.billing_month !== scope.billingMonth) hold();
  const matched = await matchUoaPaidReceiptSet(reader, scope, proof);
  const raw = usage.lines.filter(line => line.billingDisposition === 'paid').reduce((sum, line) => {
    if (line.selectedProviderCost === null || line.currency !== 'USD') hold();
    return sum.add(line.selectedProviderCost);
  }, new Prisma.Decimal(0));
  if (raw.toFixed(18) !== matched.rawCostTotal) hold();
  const rows = await reader.$queryRaw<CapturedRow[]>(Prisma.sql`
    SELECT l.dispatch_id,l.receipt_id,l.rated_microcredits AS rated,l.currency,
      COALESCE(b.billing_account_id,w.account_id) AS account_id,a.livemode,
      (b.dispatch_id IS NOT NULL AND b.org_id=l.org_id AND b.team_id=l.team_id AND b.service_id=l.service_id
        AND b.billing_month=l.billing_month AND b.tariff_id=l.tariff_id AND b.payment_mode=l.payment_mode
        AND b.currency=l.currency AND b.provider_service_id=l.provider_service_id AND b.frozen_markup_bps=l.frozen_markup_bps
        AND b.status='SETTLED' AND (b.billing_account_id IS NULL OR w.account_id IS NULL OR b.billing_account_id=w.account_id)
        AND ((l.payment_mode='PREPAID' AND w.id IS NOT NULL AND w.org_id=l.org_id AND w.currency='USD'
          AND (w.scope='ORGANISATION' AND w.team_id IS NULL OR w.scope='TEAM' AND w.team_id=l.team_id))
          OR l.payment_mode='PAY_AS_YOU_GO' AND l.credit_account_id IS NULL)) AS valid,
      e.waived_microcredits AS waived,
      (e.dispatch_id IS NULL OR (e.status='WRITTEN_OFF' AND e.receipt_id=l.receipt_id
        AND e.gross_rated_microcredits=l.rated_microcredits AND e.waived_microcredits>=0
        AND e.collectible_microcredits>=0 AND e.collectible_microcredits+e.waived_microcredits=l.rated_microcredits)) AS exception_valid
    FROM billing_paid_usage_liabilities l
    LEFT JOIN billing_credit_budget_dispatches b ON b.dispatch_id=l.dispatch_id
    LEFT JOIN billing_credit_accounts w ON w.id=l.credit_account_id
    LEFT JOIN billing_stripe_accounts a ON a.id=COALESCE(b.billing_account_id,w.account_id)
    LEFT JOIN billing_paid_usage_exceptions e ON e.dispatch_id=l.dispatch_id
    WHERE l.service_id=${scope.serviceId} AND l.org_id=${scope.organisationId}
      AND l.team_id=${scope.teamId} AND l.billing_month=${scope.billingMonth}
      AND NOT (COALESCE(b.tariff_mode,'')='FREE' AND l.rated_microcredits=0)
    UNION ALL
    SELECT l.dispatch_id,l.receipt_id,l.rated_microcredits AS rated,'USD' AS currency,
      w.account_id,a.livemode,
      (l.source_type='prepaid_wallet_debit' AND r.dispatch_id=l.dispatch_id AND r.receipt_id=l.receipt_id
        AND r.service_id=l.service_id AND r.org_id=l.org_id AND r.team_id=l.team_id AND r.billing_month=l.billing_month
        AND r.status='SETTLED' AND r.debited_microcredits=l.rated_microcredits AND w.org_id=l.org_id AND w.currency='USD'
        AND (w.scope='ORGANISATION' AND w.team_id IS NULL OR w.scope='TEAM' AND w.team_id=l.team_id)) AS valid,
      0::bigint AS waived,true AS exception_valid
    FROM billing_credit_budget_legacy_liabilities l
    LEFT JOIN billing_prepaid_reservations r ON r.id=l.source_id
    LEFT JOIN billing_credit_accounts w ON w.id=r.credit_account_id
    LEFT JOIN billing_stripe_accounts a ON a.id=w.account_id
    WHERE l.service_id=${scope.serviceId} AND l.org_id=${scope.organisationId}
      AND l.team_id=${scope.teamId} AND l.billing_month=${scope.billingMonth}
    LIMIT 100001`);
  if (rows.length > 100000) hold();
  const sources = new Map<string, { mode: 'live' | 'sandbox'; rated: bigint; waived: bigint }>();
  for (const row of rows) {
    if (!row.valid || !row.exception_valid || !row.account_id || row.livemode === null ||
      row.currency !== 'USD' || row.rated < 0n) hold();
    const mode = row.livemode ? 'live' : 'sandbox';
    const source = sources.get(row.account_id) ?? { mode, rated: 0n, waived: 0n };
    if (source.mode !== mode) hold();
    source.rated += row.rated; source.waived += row.waived ?? 0n;
    sources.set(row.account_id, source);
  }
  if (sources.size > 100 || [...sources.values()].reduce((sum, row) => sum + row.rated, 0n) !== matched.ratedMicrocredits) hold();
  const copy = billingTeamCopy(locale);
  return { as_of: proof.snapshot.captured_at, sources: [...sources].map(([accountId, row]) => ({
    source_ref: billingTeamSourceRef(scope.organisationId, scope.teamId, accountId), mode: row.mode,
    label: row.mode === 'live' ? copy.live : copy.sandbox,
    recorded_usage: billingCreditAmount(row.rated, locale), waived_usage: billingCreditAmount(row.waived, locale),
  })).sort((a, b) => a.source_ref.localeCompare(b.source_ref)) };
}

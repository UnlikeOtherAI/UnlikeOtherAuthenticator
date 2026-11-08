import { BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { MonthlyChargeSource } from './billing-monthly-subscription-quote.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';

type Reader = PrismaClient | Prisma.TransactionClient;
type Scope = { orgId: string; serviceId: string; teamId: string | null };

/** A monthly source owns its provider account forever. Current organisation
 * mode and the existence of other wallets are not historical evidence. */
export async function monthlyCycleAccount(reader: Reader, scope: Scope,
  source: MonthlyChargeSource): Promise<string | null> {
  if (!source || !['stripe', 'manual'].includes(source.kind) ||
    typeof source.id !== 'string' || !source.id) return null;
  if (source.kind === 'stripe') {
    const row = await reader.billingStripeSubscription.findFirst({ where: {
      id: source.id, orgId: scope.orgId, serviceId: scope.serviceId,
      teamId: scope.teamId,
    }, select: { accountId: true } });
    return row?.accountId ?? null;
  }
  if (scope.teamId !== null) return null;
  const row = await reader.billingContractServiceTerm.findFirst({ where: {
    id: source.id, serviceId: scope.serviceId,
    contractVersion: { contract: { orgId: scope.orgId } },
  }, select: { contractVersion: { select: { contract: {
    select: { billingAccountId: true },
  } } } } });
  return row?.contractVersion.contract.billingAccountId ?? null;
}

/** Usage-only cycles may prove a binding through their actual paid dispatches;
 * an empty/unbound/mixed period cannot choose a wallet from ambient mode. */
export async function paidCycleAccount(reader: Reader,
  scope: Scope & { billingMonth: string }): Promise<string | null> {
  const rows = await reader.$queryRaw<Array<{ account_id: string | null }>>(Prisma.sql`
    SELECT DISTINCT COALESCE(b.billing_account_id,w.account_id) AS account_id
    FROM billing_paid_usage_liabilities l
    LEFT JOIN billing_credit_budget_dispatches b ON b.dispatch_id=l.dispatch_id
    LEFT JOIN billing_credit_accounts w ON w.id=l.credit_account_id AND w.org_id=l.org_id
    WHERE l.org_id=${scope.orgId} AND l.service_id=${scope.serviceId}
      AND l.team_id=${scope.teamId} AND l.billing_month=${scope.billingMonth}
      AND NOT (COALESCE(b.tariff_mode,'')='FREE' AND l.rated_microcredits=0)
    LIMIT 2`);
  return rows.length === 1 ? rows[0]?.account_id ?? null : null;
}

/** Replay uses only captured evidence, never resolves the current mode. */
export async function capturedCycleAccount(reader: Reader,
  cycle: Scope & { payerScope: BillingAssignmentScope; billingMonth: string },
  evidence: Record<string, unknown>): Promise<string | null> {
  const quote = evidence.quote as { source?: MonthlyChargeSource } | undefined;
  if (quote?.source) return monthlyCycleAccount(reader, cycle, quote.source);
  const parentId = evidence.organisation_cycle_id;
  if (typeof parentId === 'string') {
    const parent = await reader.billingCustomerCycle.findFirst({ where: {
      id: parentId, orgId: cycle.orgId, serviceId: cycle.serviceId,
      teamId: null, billingMonth: cycle.billingMonth,
    } });
    if (!parent || billingCycleSnapshotDigest(parent.publicSnapshot, parent.privateEvidence) !==
      parent.snapshotSha256) throw new AppError('INTERNAL', 409,
      'BILLING_CYCLE_ACCOUNT_BINDING_RECONCILIATION_REQUIRED');
    const parentQuote = (parent.privateEvidence as Record<string, unknown>).quote as
      { source?: MonthlyChargeSource } | undefined;
    if (parentQuote?.source) {
      const accountId = await monthlyCycleAccount(reader,
        { ...cycle, teamId: null }, parentQuote.source);
      if (typeof evidence.billing_account_id === 'string' &&
        evidence.billing_account_id !== accountId) throw new AppError('INTERNAL', 409,
        'BILLING_CYCLE_ACCOUNT_BINDING_RECONCILIATION_REQUIRED');
      return accountId;
    }
  }
  const boundary = evidence.wallet_boundary as { account_id?: string | null } | undefined;
  if (evidence.source === 'team_usage_only' && typeof evidence.billing_account_id === 'string') {
    const account = await reader.billingStripeAccount.findUnique({ where: {
      id: evidence.billing_account_id,
    }, select: { id: true } });
    return account?.id ?? null;
  }
  if (!boundary?.account_id) return null;
  const wallet = await reader.billingCreditAccount.findFirst({ where: {
    id: boundary.account_id, orgId: cycle.orgId, scope: cycle.payerScope,
    teamId: cycle.payerScope === BillingAssignmentScope.TEAM ? cycle.teamId : null,
  }, select: { accountId: true } });
  return wallet?.accountId ?? null;
}

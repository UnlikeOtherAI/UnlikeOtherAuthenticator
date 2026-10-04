import { createHash } from 'node:crypto';

import { BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';

type Reader = PrismaClient | Prisma.TransactionClient;

export type CycleWalletBoundary = {
  opening_microcredits: string | null;
  closing_microcredits: string | null;
  account_id: string | null;
  entry_count: string | null;
  status: 'confirmed' | 'pending_reconciliation';
  fingerprint: string;
};

function result(facts: { opening: bigint | null; closing: bigint | null;
  accountId: string | null; entryCount: bigint | null; reason: string }): CycleWalletBoundary {
  return { opening_microcredits: facts.opening?.toString() ?? null,
    closing_microcredits: facts.closing?.toString() ?? null,
    account_id: facts.accountId, entry_count: facts.entryCount?.toString() ?? null,
    status: facts.opening !== null && facts.closing !== null ?
      'confirmed' : 'pending_reconciliation',
    fingerprint: createHash('sha256').update(JSON.stringify({
      opening: facts.opening?.toString() ?? null,
      closing: facts.closing?.toString() ?? null,
      account_id: facts.accountId, entry_count: facts.entryCount?.toString() ?? null,
      reason: facts.reason,
    })).digest('hex') };
}

/** This is one payer's funded wallet, not a selected team's share of an
 * organisation pool. Entry occurred_at assigns an effect to a UTC month;
 * later backdated entries produce a new cycle revision rather than rewriting
 * an earlier frozen boundary. */
export async function readCycleWalletBoundary(reader: Reader,
  params: { orgId: string; teamId: string | null; payer: BillingAssignmentScope;
    startsAt: Date; endsAt: Date },
): Promise<CycleWalletBoundary> {
  if (params.payer === BillingAssignmentScope.ORGANISATION && params.teamId !== null) {
    return result({ opening: null, closing: null, accountId: null,
      entryCount: null, reason: 'org_pool_team_view' });
  }
  const accounts = await reader.billingCreditAccount.findMany({ where: {
    orgId: params.orgId, scope: params.payer,
    teamId: params.payer === BillingAssignmentScope.TEAM ? params.teamId : null,
    currency: 'USD',
  }, select: { id: true, balanceMicrocredits: true }, take: 2 });
  if (accounts.length !== 1) {
    return result({ opening: null, closing: null, accountId: null,
      entryCount: null, reason: accounts.length === 0 ? 'no_wallet' : 'multiple_wallets' });
  }
  const account = accounts[0];
  if (!account) throw new Error('Billing wallet lookup invariant');
  const [row] = await reader.$queryRaw<Array<{ entry_count: bigint;
    all_balance: string; opening_balance: string; closing_balance: string }>>(Prisma.sql`
    SELECT count(*) FILTER (WHERE occurred_at < ${params.endsAt})::bigint AS entry_count,
      coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount_microcredits::numeric
        ELSE -amount_microcredits::numeric END), 0)::text AS all_balance,
      coalesce(sum(CASE WHEN occurred_at < ${params.startsAt}
        THEN CASE WHEN direction = 'CREDIT' THEN amount_microcredits::numeric
          ELSE -amount_microcredits::numeric END ELSE 0 END), 0)::text AS opening_balance,
      coalesce(sum(CASE WHEN occurred_at < ${params.endsAt}
        THEN CASE WHEN direction = 'CREDIT' THEN amount_microcredits::numeric
          ELSE -amount_microcredits::numeric END ELSE 0 END), 0)::text AS closing_balance
    FROM billing_credit_entries WHERE credit_account_id = ${account.id}
  `);
  if (!row) throw new Error('Billing wallet boundary aggregate invariant');
  const opening = BigInt(row.opening_balance);
  const closing = BigInt(row.closing_balance);
  if (BigInt(row.all_balance) !== account.balanceMicrocredits ||
    opening < 0n || closing < 0n) {
    return result({ opening: null, closing: null, accountId: account.id,
      entryCount: row.entry_count, reason: 'unproven_genesis_or_negative_boundary' });
  }
  return result({ opening, closing, accountId: account.id,
    entryCount: row.entry_count, reason: 'verified_entries' });
}

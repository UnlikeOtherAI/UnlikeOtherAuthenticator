import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';

export const BILLING_MODE_PERIOD_HOLDS = [
  'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED',
  'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED',
  'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH',
] as const;

/** Monthly Ledger totals have no Stripe dimension. Never assign one total to two modes. */
export async function assertBillingPeriodMode(tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { accountId: string; orgId: string; teamId: string | null; month: string; sourceCreatedAt: Date }) {
  try {
    await tx.$queryRaw(Prisma.sql`SELECT assert_billing_period_mode(${input.accountId},
      ${input.orgId}, ${input.teamId}, ${input.month}, ${input.sourceCreatedAt})::text`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = BILLING_MODE_PERIOD_HOLDS.find((hold) => message.includes(hold));
    if (code) throw new AppError('BAD_REQUEST', 409, code);
    throw error;
  }
}

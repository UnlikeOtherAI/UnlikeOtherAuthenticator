import { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

export async function lockCreditAccountAgainstAutoTopUp(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
): Promise<bigint | null> {
  await tx.$queryRaw(Prisma.sql`
    WITH account_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`credit-auto-top-up:${creditAccountId}`}, 0)
      )
    )
    SELECT 1::integer AS "locked" FROM account_lock
  `);
  const rows = await tx.$queryRaw<Array<{ balanceMicrocredits: bigint }>>(Prisma.sql`
    SELECT "balance_microcredits" AS "balanceMicrocredits"
    FROM "billing_credit_accounts"
    WHERE "id" = ${creditAccountId}
    FOR UPDATE
  `);
  return rows.length === 1 ? rows[0].balanceMicrocredits : null;
}

export async function lockCreditBalance(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ balanceMicrocredits: bigint }>>(Prisma.sql`
    SELECT "balance_microcredits" AS "balanceMicrocredits"
    FROM "billing_credit_accounts"
    WHERE "id" = ${creditAccountId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ACCOUNT_NOT_FOUND');
  }
  return rows[0].balanceMicrocredits;
}

import { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

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

import type { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

/** The admission trigger compares activation against PostgreSQL's UTC clock. */
export async function observedBillingTime(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ observedAt: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "observedAt"
  `;
  const observedAt = rows[0]?.observedAt;
  if (!(observedAt instanceof Date)) {
    throw new AppError('INTERNAL', 500, 'BILLING_OBSERVED_TIME_MISSING');
  }
  return observedAt;
}

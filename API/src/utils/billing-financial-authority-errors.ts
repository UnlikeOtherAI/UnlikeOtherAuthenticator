import { Prisma } from '@prisma/client';
import { AppError } from './errors.js';

const managerRefusals = new Set(['BILLING_MANAGER_REQUIRED',
  'customer billing action intent lacks current exact authority']);

/** A role/epoch revocation can win after the service precheck. Return the same
 * authority refusal, never the SQL/Prisma diagnostic or a dependency outage. */
export function billingFinancialAuthorityDatabaseRefusal(error: unknown): AppError | null {
  let message: string | undefined;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === '23514') {
    message = typeof error.meta.message === 'string' ? error.meta.message : undefined;
    message = message?.replace(/^ERROR:\s*/, '').split('\n')[0]?.trim();
  } else if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    message = /PostgresError \{ code: "23514", message: "([^"]+)"/.exec(error.message)?.[1];
  }
  return message && managerRefusals.has(message) ? new AppError('FORBIDDEN', 403, 'BILLING_MANAGER_REQUIRED') : null;
}

import { Prisma } from '@prisma/client';
import { AppError } from './errors.js';

const refusals = new Set(['BILLING_CONTEXT_REQUIRED', 'BILLING_CONTEXT_STALE',
  'BILLING_TEAM_MODE_CHANGED', 'BILLING_TEAM_MODE_BLOCKED', 'BILLING_HISTORICAL_WORK_PENDING',
  'BILLING_ORGANISATION_MODES_MIXED']);

/** Surface only named capture-guard refusals, never SQL or Prisma diagnostics. */
export function billingModeDatabaseRefusal(error: unknown): AppError | null {
  let message: string | undefined;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === 'P0001') {
    message = typeof error.meta.message === 'string' ? error.meta.message : undefined;
    message = message?.replace(/^ERROR:\s*/, '').split('\n')[0]?.trim();
  } else if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    message = /PostgresError \{ code: "P0001", message: "([A-Z_]+)"/.exec(error.message)?.[1];
  }
  return message && refusals.has(message) ? new AppError('BAD_REQUEST', 409, message) : null;
}

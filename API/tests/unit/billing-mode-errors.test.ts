import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { billingModeDatabaseRefusal } from '../../src/utils/billing-mode-errors.js';
describe('billing capture guard public refusals', () => {
  it.each(['BILLING_CONTEXT_REQUIRED', 'BILLING_CONTEXT_STALE', 'BILLING_TEAM_MODE_CHANGED',
    'BILLING_HISTORICAL_WORK_PENDING', 'BILLING_ORGANISATION_MODES_MIXED'])(
    'normalizes raw and model guard errors without SQL diagnostics (%s)', code => {
      const errors = [new Prisma.PrismaClientKnownRequestError('query details', {
        clientVersion: 'test', code: 'P2010', meta: { code: 'P0001', message: `ERROR: ${code}` } }),
      new Prisma.PrismaClientUnknownRequestError(`query details PostgresError { code: "P0001", message: "${code}", severity: "ERROR" }`, { clientVersion: 'test' })];
      for (const error of errors) {
        expect(billingModeDatabaseRefusal(error)).toMatchObject({ statusCode: 409, message: code });
        expect(billingModeDatabaseRefusal(error)?.message).not.toContain('query details');
      }
    });
  it('never treats arbitrary provider text or another database constraint as a mode refusal', () => {
    expect(billingModeDatabaseRefusal(new Error('BILLING_CONTEXT_STALE'))).toBeNull();
    expect(billingModeDatabaseRefusal(new Prisma.PrismaClientKnownRequestError('BILLING_CONTEXT_STALE', {
      clientVersion: 'test', code: 'P2010', meta: { code: '23514', message: 'BILLING_CONTEXT_STALE' } }))).toBeNull();
  });
});

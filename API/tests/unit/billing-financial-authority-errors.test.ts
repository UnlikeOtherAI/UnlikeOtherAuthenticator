import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { billingFinancialAuthorityDatabaseRefusal } from '../../src/utils/billing-financial-authority-errors.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';
import { AppError } from '../../src/utils/errors.js';
beforeAll(() => vi.stubEnv('DEBUG_ENABLED', 'false'));
afterAll(() => vi.unstubAllEnvs());
describe('current billing authority refusal after a database race', () => {
  it.each(['BILLING_MANAGER_REQUIRED', 'customer billing action intent lacks current exact authority'])(
    'normalizes only the exact known SQL authority refusal (%s)', message => {
      for (const error of [new Prisma.PrismaClientKnownRequestError('private query', { clientVersion: 'test', code: 'P2010',
        meta: { code: '23514', message: `ERROR: ${message}` } }),
      new Prisma.PrismaClientUnknownRequestError(`private query PostgresError { code: "23514", message: "${message}" }`, { clientVersion: 'test' })]) {
        expect(billingFinancialAuthorityDatabaseRefusal(error)).toMatchObject({ statusCode: 403, message: 'BILLING_MANAGER_REQUIRED' });
      }
    });
  it('does not reinterpret arbitrary provider text or another constraint', () => {
    expect(billingFinancialAuthorityDatabaseRefusal(new Error('BILLING_MANAGER_REQUIRED'))).toBeNull();
    expect(billingFinancialAuthorityDatabaseRefusal(new Prisma.PrismaClientKnownRequestError('private query', {
      clientVersion: 'test', code: 'P2010', meta: { code: '23514', message: 'Some other constraint' } }))).toBeNull();
  });
  it('preserves the documented new profile/authority codes with production debug disabled', () => {
    for (const [message, statusCode] of [['BILLING_MANAGER_REQUIRED', 403], ['BILLING_TEAM_ACCESS_REQUIRED', 403],
      ['BILLING_AUTHORITY_PROTOCOL_UNSUPPORTED', 400]] as const) {
      const body = buildPublicErrorBody({ request: {} as never, error: new AppError('FORBIDDEN', statusCode, message), statusCode });
      expect(JSON.stringify(body)).toContain(message);
    }
  });
});

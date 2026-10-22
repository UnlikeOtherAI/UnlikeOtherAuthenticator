import { AppError } from '../utils/errors.js';

/** A currency UOA sells credits in: USD, or a billing region's GBP or EUR. */
export function requireCreditCurrency(value: string): 'USD' | 'EUR' | 'GBP' {
  const code = value.toUpperCase();
  if (code !== 'USD' && code !== 'EUR' && code !== 'GBP') {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_CURRENCY_INVALID');
  }
  return code;
}

export function exactMinor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AMOUNT_INVALID');
  }
  return BigInt(value);
}

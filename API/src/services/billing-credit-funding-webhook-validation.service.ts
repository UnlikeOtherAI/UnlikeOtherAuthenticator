import { AppError } from '../utils/errors.js';

export function requireUsd(value: string): 'USD' {
  if (value.toUpperCase() !== 'USD') {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_CURRENCY_INVALID');
  }
  return 'USD';
}

export function exactMinor(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AMOUNT_INVALID');
  }
  return BigInt(value);
}

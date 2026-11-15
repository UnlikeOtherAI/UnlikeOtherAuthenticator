import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export function validId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new AppError('BAD_REQUEST', 400, 'PREPAID_DISPATCH_ID_INVALID');
  return value;
}

export function rawCost(value: string): Prisma.Decimal {
  if (!DECIMAL_PATTERN.test(value)) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_INVALID');
  const decimal = new Prisma.Decimal(value);
  if (decimal.decimalPlaces() > 18 || !decimal.isFinite() || decimal.isNegative()) {
    throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_INVALID');
  }
  return decimal;
}

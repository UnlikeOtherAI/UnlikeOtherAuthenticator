import { AppError } from '../utils/errors.js';

const PERCENT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const MAX_MARKUP_BPS = 100_000n;

/** Operator percentages are exact decimal strings; no floating-point scaling. */
export function markupPercentToBps(value: string): number {
  const match = PERCENT_PATTERN.exec(value);
  const whole = match?.[1];
  if (whole === undefined) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MARKUP_PERCENT');
  }
  const basisPoints = BigInt(whole) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (basisPoints > MAX_MARKUP_BPS) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MARKUP_PERCENT');
  }
  return Number(basisPoints);
}

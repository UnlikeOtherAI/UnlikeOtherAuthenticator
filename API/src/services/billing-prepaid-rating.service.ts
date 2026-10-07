import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;

export function scaledRaw(value: Prisma.Decimal): bigint {
  const [whole, fraction = ''] = value.toFixed(18).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

function ratedMicrocreditsScaled(scaled: bigint, markupBps: number): bigint {
  const denominator = 10_000n * 10n ** 18n;
  const numerator = scaled * BigInt(10_000 + markupBps) * 1_000_000_000n;
  const credits = (numerator + denominator - 1n) / denominator;
  if (credits > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_TOO_LARGE');
  return credits;
}

export function ratedMicrocreditsFromQuanta(quanta: bigint): bigint {
  const denominator = 10_000n * 10n ** 18n;
  const credits = (quanta * 1_000_000_000n + denominator - 1n) / denominator;
  if (credits > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_TOO_LARGE');
  return credits;
}

export function ratedMicrocredits(value: Prisma.Decimal, markupBps: number): bigint {
  return ratedMicrocreditsScaled(scaledRaw(value), markupBps);
}

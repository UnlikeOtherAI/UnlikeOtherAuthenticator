import { BillingCollectionMode, BillingTariffMode } from '@prisma/client';

import { AppError } from '../utils/errors.js';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TARIFF_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MARKUP_BPS = 100_000;
export const DEFAULT_STANDARD_MARKUP_BPS = 3_000;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export type PublicTariffMode = 'standard' | 'free' | 'at_cost' | 'custom';
export type PublicBillingCollectionMode = 'stripe' | 'manual' | 'none';

export type TariffInput = {
  key: string;
  name: string;
  mode: PublicTariffMode;
  collectionMode: PublicBillingCollectionMode;
  markupBps?: number;
  monthlyAmountMinor: string;
  currency: string;
};

type NormalizedTariffInput = Omit<TariffInput, 'mode' | 'collectionMode' | 'monthlyAmountMinor' | 'markupBps'> & {
  mode: BillingTariffMode;
  collectionMode: BillingCollectionMode;
  markupBps: number;
  monthlyAmountMinor: bigint;
};

export function normalizeBillingServiceIdentifier(value: string): string {
  const identifier = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_SERVICE_IDENTIFIER');
  }
  return identifier;
}

function toDatabaseMode(mode: PublicTariffMode): BillingTariffMode {
  const mapped = {
    standard: BillingTariffMode.STANDARD,
    free: BillingTariffMode.FREE,
    at_cost: BillingTariffMode.AT_COST,
    custom: BillingTariffMode.CUSTOM,
  } as const;
  return mapped[mode];
}

function toDatabaseCollectionMode(mode: PublicBillingCollectionMode): BillingCollectionMode {
  const mapped = {
    stripe: BillingCollectionMode.STRIPE,
    manual: BillingCollectionMode.MANUAL,
    none: BillingCollectionMode.NONE,
  } as const;
  return mapped[mode];
}

export function normalizeTariffInput(input: TariffInput): NormalizedTariffInput {
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!TARIFF_KEY_PATTERN.test(key) || !name || name.length > 120) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_INPUT');
  }
  const mode = toDatabaseMode(input.mode);
  const markupBps = input.markupBps ??
    (mode === BillingTariffMode.STANDARD ? DEFAULT_STANDARD_MARKUP_BPS : 0);
  if (mode === BillingTariffMode.CUSTOM && input.markupBps === undefined) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MARKUP');
  }
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > MAX_MARKUP_BPS) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MARKUP');
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_CURRENCY');
  }

  let monthlyAmountMinor: bigint;
  try {
    monthlyAmountMinor = BigInt(input.monthlyAmountMinor);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_MONTHLY_AMOUNT');
  }
  if (
    monthlyAmountMinor < 0n ||
    monthlyAmountMinor > MAX_INT64 ||
    !/^(0|[1-9]\d*)$/.test(input.monthlyAmountMinor)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_MONTHLY_AMOUNT');
  }

  const collectionMode = toDatabaseCollectionMode(input.collectionMode);
  if (
    ((mode === BillingTariffMode.FREE || mode === BillingTariffMode.AT_COST) &&
      markupBps !== 0) ||
    (mode === BillingTariffMode.FREE &&
      (monthlyAmountMinor !== 0n || collectionMode !== BillingCollectionMode.NONE))
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_TARIFF_MODE_VALUES');
  }

  return {
    key,
    name,
    mode,
    collectionMode,
    markupBps,
    monthlyAmountMinor,
    currency,
  };
}


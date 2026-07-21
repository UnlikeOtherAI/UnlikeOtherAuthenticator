import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const UNITS_PER_CREDIT = 1_000_000n;
const CREDIT_INPUT_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,5})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type AdminCreditActor = { userId: string; email: string };

export type AdminCreditAdjustmentIntent = {
  creditAccountId: string;
  organisationId: string;
  teamId: string;
  signedCredits: string;
  reason: string;
  idempotencyKey: string;
  actor: AdminCreditActor;
};

export function parseAdminCreditValue(input: string, allowZero = true): bigint {
  const value = input.trim();
  if (value.length > 40 || !CREDIT_INPUT_PATTERN.test(value)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const unsigned = BigInt(whole) * UNITS_PER_CREDIT + BigInt(fraction.padEnd(6, '0'));
  const signed = negative ? -unsigned : unsigned;
  if (
    (!allowZero && signed === 0n) ||
    signed < MIN_INT64 ||
    signed > MAX_INT64 ||
    signed % 10n !== 0n
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID');
  }
  return signed;
}

export function normalizeAdminCreditAdjustmentIntent(input: AdminCreditAdjustmentIntent) {
  const value = {
    creditAccountId: input.creditAccountId.trim(),
    organisationId: input.organisationId.trim(),
    teamId: input.teamId.trim(),
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    userId: input.actor.userId.trim(),
    email: input.actor.email.trim(),
    signedAmountMicrocredits: parseAdminCreditValue(input.signedCredits, false),
  };
  if (
    !value.creditAccountId ||
    !value.organisationId ||
    !value.teamId ||
    !value.userId ||
    !value.email ||
    value.email.length > 320 ||
    !value.reason ||
    value.reason.length > 1000 ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_INVALID');
  }
  return value;
}

export function resolveAdminCreditAdjustmentContext(deps: {
  adminDomain?: string;
  confirmationSecret?: string;
}) {
  const env = deps.adminDomain && deps.confirmationSecret ? undefined : getEnv();
  const domain = normalizeDomain(deps.adminDomain ?? (env ? getAdminAuthDomain(env) : ''));
  const secret = deps.confirmationSecret ?? env?.ADMIN_ACCESS_TOKEN_SECRET;
  if (!domain) throw new AppError('INTERNAL', 500, 'ADMIN_AUTH_DOMAIN_REQUIRED');
  if (!secret) throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  return { domain, secret };
}

export function adminCreditResultingBalance(current: bigint, delta: bigint): bigint {
  const result = current + delta;
  if (result < MIN_INT64 || result > MAX_INT64) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_BALANCE_INVALID');
  }
  if (delta < 0n && result < 0n) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_INSUFFICIENT');
  }
  return result;
}

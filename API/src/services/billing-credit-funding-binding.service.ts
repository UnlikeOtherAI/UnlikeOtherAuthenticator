import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';
import type { CreditPaymentBinding } from './billing-credit-funding-webhook.types.js';

const LOCAL_KEYS = {
  top_up: 'uoa_credit_top_up_checkout_id',
  automatic_top_up: 'uoa_credit_auto_top_up_attempt_id',
  setup: 'uoa_credit_setup_checkout_id',
} as const;

const FINGERPRINT_KEYS = ['uoa_service_id', 'uoa_app_key_id', 'uoa_credit_account_id'] as const;

export type CreditFundingMetadataBinding = {
  localId: string;
  localType: keyof typeof LOCAL_KEYS;
  serviceId: string;
  appKeyId: string;
  creditAccountId: string;
};

function invalidMetadata(): never {
  throw new AppError('BAD_REQUEST', 400, 'STRIPE_CREDIT_METADATA_INVALID');
}

function parseMetadata(
  metadata: Stripe.Metadata | null | undefined,
): CreditFundingMetadataBinding | null {
  const value = metadata ?? {};
  const present = Object.entries(LOCAL_KEYS).filter(([, key]) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  const hasFingerprint = FINGERPRINT_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (present.length === 0) {
    if (hasFingerprint) invalidMetadata();
    return null;
  }
  if (present.length !== 1) invalidMetadata();
  const entry = present[0];
  if (!entry) invalidMetadata();
  const [localType, localKey] = entry as [keyof typeof LOCAL_KEYS, string];
  const localId = value[localKey]?.trim();
  const serviceId = value.uoa_service_id?.trim();
  const appKeyId = value.uoa_app_key_id?.trim();
  const creditAccountId = value.uoa_credit_account_id?.trim();
  if (!localId || !serviceId || !appKeyId || !creditAccountId) invalidMetadata();
  return { localId, localType, serviceId, appKeyId, creditAccountId };
}

export function creditFundingMetadata(
  expected: CreditFundingMetadataBinding,
): Stripe.MetadataParam {
  return {
    [LOCAL_KEYS[expected.localType]]: expected.localId,
    uoa_service_id: expected.serviceId,
    uoa_app_key_id: expected.appKeyId,
    uoa_credit_account_id: expected.creditAccountId,
  };
}

export function assertCreditFundingMetadata(
  metadata: Stripe.Metadata | null | undefined,
  expected: CreditFundingMetadataBinding,
  errorCode = 'STRIPE_CREDIT_BINDING_INVALID',
): void {
  const actual = parseMetadata(metadata);
  if (
    !actual ||
    actual.localId !== expected.localId ||
    actual.localType !== expected.localType ||
    actual.serviceId !== expected.serviceId ||
    actual.appKeyId !== expected.appKeyId ||
    actual.creditAccountId !== expected.creditAccountId
  ) {
    throw new AppError('INTERNAL', 502, errorCode);
  }
}

export function sameCreditFundingMetadata(
  left: Stripe.Metadata | null | undefined,
  right: Stripe.Metadata | null | undefined,
): boolean {
  const first = parseMetadata(left);
  const second = parseMetadata(right);
  return (
    first?.localId === second?.localId &&
    first?.localType === second?.localType &&
    first?.serviceId === second?.serviceId &&
    first?.appKeyId === second?.appKeyId &&
    first?.creditAccountId === second?.creditAccountId
  );
}

export function paymentBinding(
  metadata: Stripe.Metadata | null | undefined,
): CreditPaymentBinding | null {
  const binding = parseMetadata(metadata);
  if (!binding || binding.localType === 'setup') return null;
  return { localId: binding.localId, localType: binding.localType };
}

export function setupBinding(metadata: Stripe.Metadata | null | undefined): string | null {
  const binding = parseMetadata(metadata);
  return binding?.localType === 'setup' ? binding.localId : null;
}

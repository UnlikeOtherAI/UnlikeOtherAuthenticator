import { BillingCreditAutoTopUpState, Prisma } from '@prisma/client';

/** Clear only the current consent pointers. Immutable revisions and financial
 * history remain; the caller must first persist its exact disable authority.
 */
export const disabledAutoTopUpState = () => ({
  autoTopUpGeneration: { increment: 1 },
  autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
  autoTopUpPolicyId: null,
  autoTopUpServiceId: null,
  autoTopUpAppKeyId: null,
  autoTopUpConsentRevisionId: null,
  autoTopUpOptionId: null,
  autoTopUpThresholdMicrocredits: null,
  autoTopUpRefillOfferId: null,
  autoTopUpMonthlyChargeCapMinor: null,
  autoTopUpConsentVersion: null,
  autoTopUpConsentedAt: null,
  autoTopUpConsentedByUserId: null,
  stripePaymentMethodId: null,
  paymentMethodSummary: Prisma.DbNull,
}) satisfies Prisma.BillingCreditAccountUncheckedUpdateManyInput;

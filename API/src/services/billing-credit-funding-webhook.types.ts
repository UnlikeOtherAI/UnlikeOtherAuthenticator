import type { BillingCreditPaymentAdjustmentKind, Prisma } from '@prisma/client';
import type Stripe from 'stripe';

export type CreditFundingWebhookClient = Pick<
  Stripe,
  | 'checkout'
  | 'disputes'
  | 'paymentIntents'
  | 'paymentMethods'
  | 'refunds'
  | 'setupIntents'
>;

export type CreditPaymentBinding = {
  localId: string;
  localType: 'automatic_top_up' | 'top_up';
};

export type CreditFundingEvent =
  | ({
      kind: 'payment_succeeded';
      paymentIntent: Stripe.PaymentIntent;
      paymentMethodId: string;
      chargeId: string;
      checkoutSessionId: string | null;
      occurredAt: Date;
    } & CreditPaymentBinding)
  | ({
      kind: 'payment_failed';
      paymentIntent: Stripe.PaymentIntent;
      paymentMethodId: string | null;
      chargeId: string | null;
      checkoutSessionId: string | null;
      occurredAt: Date;
    } & CreditPaymentBinding)
  | ({
      kind: 'payment_state_changed';
      paymentIntent: Stripe.PaymentIntent;
      paymentMethodId: string | null;
      state: 'canceled' | 'processing' | 'requires_action';
      occurredAt: Date;
    } & CreditPaymentBinding)
  | {
      kind: 'setup_succeeded';
      localId: string;
      setupIntent: Stripe.SetupIntent;
      checkoutSessionId: string;
      paymentMethodId: string;
      paymentMethodSummary: Prisma.InputJsonValue;
      occurredAt: Date;
    }
  | ({
      kind: 'payment_adjustment';
      adjustmentKind: BillingCreditPaymentAdjustmentKind;
      stripeObjectId: string;
      paymentIntent: Stripe.PaymentIntent;
      paymentIntentId: string;
      chargeId: string;
      amountMinor: bigint;
      currency: 'USD';
      occurredAt: Date;
    } & CreditPaymentBinding)
  | {
      kind: 'checkout_expired';
      localId: string;
      localType: 'setup' | 'top_up';
      checkoutSessionId: string;
      expiresAt: Date;
    };

export type PreparedCreditFundingWebhook = {
  event: CreditFundingEvent;
  eventFields: {
    stripeObjectId?: string;
    stripeObjectStatus?: string | null;
    stripeCustomerId?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeChargeId?: string | null;
    stripeSetupIntentId?: string | null;
    stripePaymentMethodId?: string | null;
    amountMinor?: bigint | null;
    currency?: string | null;
    stripeCreatedAt: Date;
  };
};

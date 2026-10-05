import type Stripe from 'stripe';

import type { CreditAutoTopUpClaim } from './billing-credit-auto-top-up-attempt.service.js';
import type { CreditAutoTopUpEventRecoveryDiagnostic } from './billing-credit-auto-top-up-event-recovery.service.js';

export type CreditAutoTopUpDispatchResult = {
  creditAccountId: string;
  outcome: 'submitted' | 'awaiting_webhook' | 'terminal' | 'skipped';
  attemptId: string;
  stripePaymentIntentId: string | null;
  stripeStatus?: Stripe.PaymentIntent.Status;
  recoveredAttempt?: boolean;
  recoveryDiagnostic?: CreditAutoTopUpEventRecoveryDiagnostic;
  reason?: 'consent_changed';
};

export type CreditAutoTopUpAccountResult =
  | CreditAutoTopUpDispatchResult
  | {
      creditAccountId: string;
      outcome: 'recovered';
      attemptId: string;
      stripePaymentIntentId: string;
    }
  | {
      creditAccountId: string;
      outcome: 'skipped';
      reason: Extract<CreditAutoTopUpClaim, { kind: 'skipped' }>['reason'];
    }
  | {
      creditAccountId: string;
      outcome: 'failed';
      attemptId?: string;
      error: string;
    };

export type CreditAutoTopUpCycleResult = {
  accountId: string;
  attempted: number;
  submitted: number;
  awaitingWebhook: number;
  recovered: number;
  terminal: number;
  skipped: number;
  failed: number;
  results: CreditAutoTopUpAccountResult[];
};

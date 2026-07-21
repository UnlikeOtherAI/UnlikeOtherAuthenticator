import {
  BillingAppKeyPurpose,
  BillingAssignmentScope,
  BillingCreditAutoTopUpAttemptStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  claimCreditAutoTopUpAttempt,
  listCreditAutoTopUpCandidateIds,
  type CreditAutoTopUpClaim,
} from './billing-credit-auto-top-up-attempt.service.js';
import {
  assertCreditFundingMetadata,
  creditFundingMetadata,
} from './billing-credit-funding-binding.service.js';
import {
  assertStripeObjectLivemode,
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { stripeExternalId } from './billing-stripe-webhook-utils.service.js';

const AUTO_TOP_UP_BATCH_SIZE = 100;
const AUTO_TOP_UP_CONCURRENCY = 10;
// The Stripe client permits two retries with a 20-second request timeout. Keep
// the account lock alive across that full ambiguity-recovery window so another
// replica cannot start the same durable attempt while the SDK is still retrying.
const DISPATCH_TRANSACTION_TIMEOUT_MS = 75_000;

type CreditAutoTopUpStripeClient = Pick<Stripe, 'accounts' | 'paymentIntents'>;

type AccountResult =
  | {
      creditAccountId: string;
      outcome: 'submitted' | 'awaiting_webhook' | 'terminal';
      attemptId: string;
      stripePaymentIntentId: string | null;
      stripeStatus?: Stripe.PaymentIntent.Status;
      recoveredAttempt?: boolean;
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
  terminal: number;
  skipped: number;
  failed: number;
  results: AccountResult[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'BILLING_CREDIT_AUTO_TOP_UP_UNKNOWN_FAILURE';
}

function embeddedPaymentIntent(error: unknown): Stripe.PaymentIntent | null {
  if (!error || typeof error !== 'object' || !('payment_intent' in error)) return null;
  const candidate = (error as { payment_intent?: unknown }).payment_intent;
  if (!candidate || typeof candidate !== 'object' || !('id' in candidate)) return null;
  return typeof candidate.id === 'string' ? (candidate as Stripe.PaymentIntent) : null;
}

function stripeAmount(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_AUTO_TOP_UP_AMOUNT_INVALID');
  }
  return amount;
}

async function lockDispatchSnapshot(
  tx: Prisma.TransactionClient,
  params: { creditAccountId: string; attemptId: string },
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    WITH account_lock AS (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`credit-auto-top-up:${params.creditAccountId}`}, 0)
      )
    )
    SELECT 1::integer AS "locked" FROM account_lock
  `);
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT attempt."id"
    FROM "billing_credit_auto_top_up_attempts" AS attempt
    JOIN "billing_credit_accounts" AS credit
      ON credit."id" = attempt."credit_account_id"
    JOIN "billing_stripe_customers" AS customer
      ON customer."id" = credit."customer_id"
    JOIN "billing_credit_auto_top_up_consent_revisions" AS revision
      ON revision."id" = attempt."consent_revision_id"
    JOIN "billing_credit_funding_policies" AS policy
      ON policy."id" = revision."policy_id"
    JOIN "billing_credit_auto_top_up_options" AS option
      ON option."id" = attempt."option_id"
    JOIN "billing_credit_top_up_offers" AS offer
      ON offer."id" = attempt."offer_id"
    JOIN "billing_credit_top_up_catalogs" AS catalog
      ON catalog."id" = attempt."catalog_id"
    JOIN "billing_app_keys" AS app_key
      ON app_key."id" = attempt."app_key_id"
    WHERE attempt."id" = ${params.attemptId}
      AND attempt."credit_account_id" = ${params.creditAccountId}
    FOR UPDATE OF attempt, credit, customer, revision, policy, option, offer, catalog, app_key
  `);
  if (rows.length !== 1) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_AUTO_TOP_UP_ATTEMPT_NOT_FOUND');
  }
}

function loadAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  return tx.billingCreditAutoTopUpAttempt.findUnique({
    where: { id: attemptId },
    include: {
      appKey: true,
      catalog: true,
      consentRevision: true,
      creditAccount: { include: { customer: true } },
      offer: true,
      option: true,
    },
  });
}

type DispatchAttempt = NonNullable<Awaited<ReturnType<typeof loadAttempt>>>;

function assertAttemptBinding(attempt: DispatchAttempt, account: StripeAccountContext): void {
  const revision = attempt.consentRevision;
  const credit = attempt.creditAccount;
  const customer = credit.customer;
  if (
    attempt.accountId !== account.id ||
    credit.accountId !== account.id ||
    customer.accountId !== account.id ||
    customer.orgId !== credit.orgId ||
    customer.teamId !== credit.teamId ||
    customer.scope !== BillingAssignmentScope.TEAM ||
    customer.scopeKey !== `${credit.orgId}:${credit.teamId}` ||
    !customer.stripeCustomerId ||
    attempt.creditAccountId !== credit.id ||
    attempt.catalog.accountId !== account.id ||
    attempt.catalog.currency !== 'USD' ||
    attempt.catalog.paymentAmountMinor !== attempt.paymentAmountMinor ||
    attempt.catalog.creditsReceivedMicrocredits !== attempt.creditsReceivedMicrocredits ||
    attempt.serviceId !== revision.serviceId ||
    attempt.appKeyId !== revision.appKeyId ||
    attempt.appKey.serviceId !== attempt.serviceId ||
    attempt.appKey.purpose !== BillingAppKeyPurpose.CUSTOMER_LIFECYCLE ||
    attempt.optionId !== revision.optionId ||
    attempt.offerId !== revision.refillOfferId ||
    attempt.option.policyId !== revision.policyId ||
    attempt.option.serviceId !== attempt.serviceId ||
    attempt.option.refillOfferId !== attempt.offerId ||
    attempt.offer.policyId !== revision.policyId ||
    attempt.offer.serviceId !== attempt.serviceId ||
    attempt.offer.catalogKey !== attempt.catalog.key ||
    attempt.offer.catalogVersion !== attempt.catalog.version ||
    attempt.offer.paymentAmountMinor !== attempt.paymentAmountMinor ||
    attempt.offer.creditsReceivedMicrocredits !== attempt.creditsReceivedMicrocredits ||
    attempt.consentVersion !== revision.consentVersion ||
    attempt.thresholdMicrocredits !== revision.thresholdMicrocredits ||
    attempt.monthlyChargeCapMinor !== revision.monthlyChargeCapMinor ||
    attempt.paymentAmountMinor !== revision.refillPaymentAmountMinor ||
    attempt.creditsReceivedMicrocredits !== revision.refillCreditsMicrocredits ||
    attempt.attributedUserId !== revision.consentedByUserId ||
    attempt.idempotencyKey !== `uoa:auto-top-up:${attempt.id}` ||
    attempt.chargedThisMonthBeforeMinor + attempt.paymentAmountMinor > attempt.monthlyChargeCapMinor
  ) {
    throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
}

function assertPaymentIntent(
  intent: Stripe.PaymentIntent,
  attempt: DispatchAttempt,
  account: StripeAccountContext,
): void {
  assertStripeObjectLivemode(intent, account.livemode);
  assertCreditFundingMetadata(
    intent.metadata,
    {
      localType: 'automatic_top_up',
      localId: attempt.id,
      serviceId: attempt.serviceId,
      appKeyId: attempt.appKeyId,
      creditAccountId: attempt.creditAccountId,
    },
    'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID',
  );
  if (
    intent.object !== 'payment_intent' ||
    !intent.id.startsWith('pi_') ||
    intent.amount !== stripeAmount(attempt.paymentAmountMinor) ||
    intent.currency.toUpperCase() !== 'USD' ||
    stripeExternalId(intent.customer) !== attempt.creditAccount.customer.stripeCustomerId ||
    stripeExternalId(intent.payment_method) !== attempt.consentRevision.stripePaymentMethodId
  ) {
    throw new AppError('INTERNAL', 502, 'STRIPE_CREDIT_AUTO_TOP_UP_BINDING_INVALID');
  }
}

async function createPaymentIntent(
  stripe: Pick<Stripe, 'paymentIntents'>,
  attempt: DispatchAttempt,
  account: StripeAccountContext,
): Promise<Stripe.PaymentIntent> {
  try {
    return await stripe.paymentIntents.create(
      {
        amount: stripeAmount(attempt.paymentAmountMinor),
        currency: 'usd',
        customer: attempt.creditAccount.customer.stripeCustomerId as string,
        payment_method: attempt.consentRevision.stripePaymentMethodId,
        confirm: true,
        off_session: true,
        metadata: creditFundingMetadata({
          localType: 'automatic_top_up',
          localId: attempt.id,
          serviceId: attempt.serviceId,
          appKeyId: attempt.appKeyId,
          creditAccountId: attempt.creditAccountId,
        }),
        description: 'UOA automatic credit top-up',
      },
      { idempotencyKey: attempt.idempotencyKey },
    );
  } catch (error) {
    const intent = embeddedPaymentIntent(error);
    if (!intent) throw error;
    assertPaymentIntent(intent, attempt, account);
    return intent;
  }
}

async function dispatchCreditAutoTopUpAttempt(
  params: { account: StripeAccountContext; creditAccountId: string; attemptId: string },
  deps: { prisma: PrismaClient; stripe: Pick<Stripe, 'paymentIntents'> },
): Promise<Extract<AccountResult, { outcome: 'submitted' | 'awaiting_webhook' | 'terminal' }>> {
  return deps.prisma.$transaction(
    async (tx) => {
      await lockDispatchSnapshot(tx, params);
      const attempt = await loadAttempt(tx, params.attemptId);
      if (!attempt) {
        throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_AUTO_TOP_UP_ATTEMPT_NOT_FOUND');
      }
      assertAttemptBinding(attempt, params.account);
      if (
        attempt.status === BillingCreditAutoTopUpAttemptStatus.SUCCEEDED ||
        attempt.status === BillingCreditAutoTopUpAttemptStatus.FAILED ||
        attempt.status === BillingCreditAutoTopUpAttemptStatus.CANCELED
      ) {
        return {
          creditAccountId: params.creditAccountId,
          outcome: 'terminal',
          attemptId: attempt.id,
          stripePaymentIntentId: attempt.stripePaymentIntentId,
        };
      }
      if (
        attempt.status !== BillingCreditAutoTopUpAttemptStatus.PENDING ||
        attempt.stripePaymentIntentId
      ) {
        return {
          creditAccountId: params.creditAccountId,
          outcome: 'awaiting_webhook',
          attemptId: attempt.id,
          stripePaymentIntentId: attempt.stripePaymentIntentId,
        };
      }
      const intent = await createPaymentIntent(deps.stripe, attempt, params.account);
      assertPaymentIntent(intent, attempt, params.account);
      await tx.billingCreditAutoTopUpAttempt.update({
        where: { id: attempt.id },
        data: { stripePaymentIntentId: intent.id },
      });
      return {
        creditAccountId: params.creditAccountId,
        outcome: 'submitted',
        attemptId: attempt.id,
        stripePaymentIntentId: intent.id,
        stripeStatus: intent.status,
      };
    },
    {
      maxWait: DISPATCH_TRANSACTION_TIMEOUT_MS,
      timeout: DISPATCH_TRANSACTION_TIMEOUT_MS,
    },
  );
}

export async function runCreditAutoTopUpAccount(
  params: { account: StripeAccountContext; creditAccountId: string },
  deps: {
    prisma: PrismaClient;
    stripe: Pick<Stripe, 'paymentIntents'>;
    claim?: typeof claimCreditAutoTopUpAttempt;
  },
): Promise<AccountResult> {
  let attemptId: string | undefined;
  try {
    const claim = await (deps.claim ?? claimCreditAutoTopUpAttempt)(
      { accountId: params.account.id, creditAccountId: params.creditAccountId },
      { prisma: deps.prisma },
    );
    if (claim.kind === 'skipped') {
      return {
        creditAccountId: params.creditAccountId,
        outcome: 'skipped',
        reason: claim.reason,
      };
    }
    attemptId = claim.attemptId;
    if (claim.kind === 'awaiting_webhook') {
      return {
        creditAccountId: params.creditAccountId,
        outcome: 'awaiting_webhook',
        attemptId: claim.attemptId,
        stripePaymentIntentId: claim.stripePaymentIntentId,
      };
    }
    const result = await dispatchCreditAutoTopUpAttempt(
      {
        account: params.account,
        creditAccountId: params.creditAccountId,
        attemptId: claim.attemptId,
      },
      deps,
    );
    return claim.created ? result : { ...result, recoveredAttempt: true };
  } catch (error) {
    return {
      creditAccountId: params.creditAccountId,
      outcome: 'failed',
      ...(attemptId ? { attemptId } : {}),
      error: errorMessage(error),
    };
  }
}

async function runInBatches(
  creditAccountIds: string[],
  execute: (creditAccountId: string) => Promise<AccountResult>,
): Promise<AccountResult[]> {
  const results: AccountResult[] = [];
  for (let offset = 0; offset < creditAccountIds.length; offset += AUTO_TOP_UP_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        creditAccountIds.slice(offset, offset + AUTO_TOP_UP_CONCURRENCY).map(execute),
      )),
    );
  }
  return results;
}

export async function runCreditAutoTopUpCycle(deps?: {
  prisma?: PrismaClient;
  stripe?: CreditAutoTopUpStripeClient;
  stripeLivemode?: boolean;
  listCandidates?: typeof listCreditAutoTopUpCandidateIds;
  runAccount?: typeof runCreditAutoTopUpAccount;
  batchSize?: number;
}): Promise<CreditAutoTopUpCycleResult> {
  const configured = deps?.stripe ? undefined : requireStripeBillingEnabled();
  const stripe = deps?.stripe ?? configured?.client;
  if (!stripe) throw new Error('STRIPE_BILLING_DISABLED');
  const prisma = deps?.prisma ?? getAdminPrisma();
  const account = await resolveStripeAccountContext(
    stripe,
    deps?.stripeLivemode ?? configured?.livemode ?? false,
    prisma,
  );
  const creditAccountIds = await (deps?.listCandidates ?? listCreditAutoTopUpCandidateIds)(
    { accountId: account.id, limit: deps?.batchSize ?? AUTO_TOP_UP_BATCH_SIZE },
    { prisma },
  );
  const results = await runInBatches(creditAccountIds, (creditAccountId) =>
    (deps?.runAccount ?? runCreditAutoTopUpAccount)(
      { account, creditAccountId },
      { prisma, stripe },
    ),
  );
  return {
    accountId: account.id,
    attempted: results.length,
    submitted: results.filter((result) => result.outcome === 'submitted').length,
    awaitingWebhook: results.filter((result) => result.outcome === 'awaiting_webhook').length,
    terminal: results.filter((result) => result.outcome === 'terminal').length,
    skipped: results.filter((result) => result.outcome === 'skipped').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    results,
  };
}

export function startCreditAutoTopUpScheduler(params: {
  log: {
    info: (details: object, message: string) => void;
    error: (details: object, message: string) => void;
  };
  runCycle?: typeof runCreditAutoTopUpCycle;
}): { stop: () => void } {
  const env = getEnv();
  let running = false;
  let stopped = false;
  let rerunRequested = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      const result = await (params.runCycle ?? runCreditAutoTopUpCycle)();
      const log = result.failed > 0 ? params.log.error : params.log.info;
      log(
        {
          attempted: result.attempted,
          submitted: result.submitted,
          awaitingWebhook: result.awaitingWebhook,
          terminal: result.terminal,
          skipped: result.skipped,
          failed: result.failed,
          failures: result.results.filter((item) => item.outcome === 'failed'),
        },
        'Stripe credit auto-top-up cycle completed',
      );
    } catch (error) {
      params.log.error({ err: error }, 'Stripe credit auto-top-up cycle failed');
    } finally {
      running = false;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        queueMicrotask(() => void run());
      }
    }
  };

  void run();
  const timer = setInterval(() => void run(), env.STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES * 60_000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

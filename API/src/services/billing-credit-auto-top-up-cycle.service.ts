import { getEnv } from '../config/env.js';
import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runStoredStripeAccountCycles } from './billing-stripe-account-cycles.service.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { listCreditAutoTopUpCandidateIds, listCreditAutoTopUpWebhookCandidates,
  type CreditAutoTopUpWebhookCandidate } from './billing-credit-auto-top-up-attempt.service.js';
import { recoverCreditAutoTopUpEvents, type CreditAutoTopUpEventRecoveryResult }
  from './billing-credit-auto-top-up-event-recovery.service.js';
import { runCreditAutoTopUpAccount, type CreditAutoTopUpStripeClient } from './billing-credit-auto-top-up-runtime.service.js';
import type { CreditAutoTopUpAccountResult as AccountResult, CreditAutoTopUpCycleResult }
  from './billing-credit-auto-top-up-runtime.types.js';
const AUTO_TOP_UP_BATCH_SIZE = 100;
const AUTO_TOP_UP_CONCURRENCY = 4;
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
  listWebhookCandidates?: typeof listCreditAutoTopUpWebhookCandidates;
  recoverEvents?: typeof recoverCreditAutoTopUpEvents;
  now?: () => Date;
  batchSize?: number;
}): Promise<CreditAutoTopUpCycleResult> {
  if (!deps?.stripe && !getEnv().STRIPE_BILLING_ENABLED) throw new Error('STRIPE_BILLING_DISABLED');
  if (!deps?.stripe) {
    const prisma = deps?.prisma ?? getAdminPrisma();
    const runs = await runStoredStripeAccountCycles(prisma, (runtime) => runCreditAutoTopUpCycle({
      ...deps, prisma, stripe: runtime.client, stripeLivemode: runtime.livemode,
    }));
    const successful = runs.flatMap((run) => 'result' in run ? [run.result] : []);
    return {
      accountId: 'all', attempted: successful.reduce((sum, run) => sum + run.attempted, 0),
      submitted: successful.reduce((sum, run) => sum + run.submitted, 0),
      awaitingWebhook: successful.reduce((sum, run) => sum + run.awaitingWebhook, 0),
      recovered: successful.reduce((sum, run) => sum + run.recovered, 0),
      terminal: successful.reduce((sum, run) => sum + run.terminal, 0),
      skipped: successful.reduce((sum, run) => sum + run.skipped, 0),
      failed: successful.reduce((sum, run) => sum + run.failed, 0) + runs.filter((run) => 'error' in run).length,
      results: runs.flatMap((run) => 'result' in run ? run.result.results : [{
        creditAccountId: `account:${run.accountId}`, outcome: 'failed' as const, error: run.error }]),
    };
  }

  const stripe = deps.stripe;
  if (!stripe) throw new Error('STRIPE_BILLING_DISABLED');
  const prisma = deps?.prisma ?? getAdminPrisma();
  const account = await resolveStripeAccountContext(
    stripe,
    deps.stripeLivemode ?? false,
    prisma,
  );
  const creditAccountIds = await (deps?.listCandidates ?? listCreditAutoTopUpCandidateIds)(
    { accountId: account.id, limit: deps?.batchSize ?? AUTO_TOP_UP_BATCH_SIZE },
    { prisma },
  );
  const webhookCandidates: CreditAutoTopUpWebhookCandidate[] = await (
    deps?.listWebhookCandidates ?? listCreditAutoTopUpWebhookCandidates
  )(
    {
      accountId: account.id,
      creditAccountIds,
      limit: deps?.batchSize ?? AUTO_TOP_UP_BATCH_SIZE,
    },
    { prisma },
  );
  const eventRecovery: CreditAutoTopUpEventRecoveryResult = await (
    deps?.recoverEvents ?? recoverCreditAutoTopUpEvents
  )({
    account,
    now: deps?.now?.() ?? new Date(),
    candidates: webhookCandidates,
    stripe,
    prisma,
  });
  const webhookCandidateByCreditAccount = new Map(
    webhookCandidates.map((candidate) => [candidate.creditAccountId, candidate]),
  );
  const results = await runInBatches(creditAccountIds, async (creditAccountId) => {
    const webhookCandidate = webhookCandidateByCreditAccount.get(creditAccountId);
    if (webhookCandidate) {
      const paymentIntentId = webhookCandidate.stripePaymentIntentId;
      const recoveredPaymentIntentId = eventRecovery.recoveredAttemptPaymentIntents.get(
        webhookCandidate.attemptId,
      );
      if (recoveredPaymentIntentId) {
        return {
          creditAccountId,
          outcome: 'recovered' as const,
          attemptId: webhookCandidate.attemptId,
          stripePaymentIntentId: recoveredPaymentIntentId,
        };
      }
      if (!paymentIntentId
        && eventRecovery.diagnostics.get(webhookCandidate.attemptId) === 'event_not_found') {
        // Reuse the committed attempt and idempotency key. The dispatch lock
        // rechecks current consent, state and the safe replay window.
        return (deps?.runAccount ?? runCreditAutoTopUpAccount)(
          { account, creditAccountId }, { prisma, stripe },
        );
      }
      return {
        creditAccountId,
        outcome: 'awaiting_webhook' as const,
        attemptId: webhookCandidate.attemptId,
        stripePaymentIntentId: paymentIntentId,
        recoveryDiagnostic:
          eventRecovery.diagnostics.get(webhookCandidate.attemptId) ?? 'event_not_found',
      };
    }
    const result = await (deps?.runAccount ?? runCreditAutoTopUpAccount)(
      { account, creditAccountId },
      { prisma, stripe },
    );
    if (result.outcome === 'awaiting_webhook' && result.stripePaymentIntentId) {
      return {
        ...result,
        recoveryDiagnostic:
          eventRecovery.diagnostics.get(result.attemptId) ?? 'event_not_found',
      };
    }
    return result;
  });
  return {
    accountId: account.id,
    attempted: results.length,
    submitted: results.filter((result) => result.outcome === 'submitted').length,
    awaitingWebhook: results.filter((result) => result.outcome === 'awaiting_webhook').length,
    recovered: results.filter((result) => result.outcome === 'recovered').length,
    terminal: results.filter((result) => result.outcome === 'terminal').length,
    skipped: results.filter((result) => result.outcome === 'skipped').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    results,
  };
}

import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { Prisma, type BillingBrowserReservation, type PrismaClient } from '@prisma/client';
import type {
  BillingBrowserReserveRequestV1,
  BillingBrowserReservationV1,
  BillingBrowserTariffRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  activeBrowserPolicy,
  browserProviderCost,
  publicBrowserTariff,
} from './billing-browser-policy.service.js';
import { lockPrepaidAppSubject, verifyPrepaidAppActor } from './billing-prepaid-app-authority.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { requireTeamStripeBilling } from './billing-team-mode.service.js';
import { resolveStripeAccountContext } from './billing-stripe-client.service.js';
import { resolveCreditAccount } from './billing-credit-account.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { reserveBudgetDispatch } from './billing-credit-budget-dispatch.service.js';
import { maximumRatedMicrocredits } from './billing-paid-liability.service.js';
import { smsMicrocredits } from './billing-sms-money.service.js';

export type BrowserBillingDependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  stripe?: Pick<Stripe, 'accounts'>;
};
export function publicBrowserReservation(
  row: BillingBrowserReservation,
  canDispatch = false,
): BillingBrowserReservationV1 {
  return {
    reservation_id: row.id,
    dispatch_id: row.dispatchId,
    policy_id: row.policyId,
    state: row.state as BillingBrowserReservationV1['state'],
    can_dispatch: canDispatch,
    reserved_credits: smsMicrocredits(row.reservedMicrocredits),
    consumed_credits: row.debitedMicrocredits === null ? null : smsMicrocredits(row.debitedMicrocredits),
    session_id: row.providerSessionId,
    max_duration_seconds: row.maxDurationSeconds,
    claim_expires_at: row.claimExpiresAt.toISOString(),
  };
}
export function assertBrowserRuntime(credential: VerifiedBillingAppKey, product: string): void {
  if (credential.purpose !== 'BROWSER_RUNTIME' || credential.service.identifier !== product) {
    throw new AppError('FORBIDDEN', 403);
  }
}
export async function lockBrowserDispatch(tx: Prisma.TransactionClient, dispatchId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`browser:${dispatchId}`}, 0))::text`,
  );
}
export async function readBrowserTariff(
  input: { request: BillingBrowserTariffRequestV1; credential: VerifiedBillingAppKey; actorToken: string },
  deps: BrowserBillingDependencies = {},
) {
  assertBrowserRuntime(input.credential, input.request.product);
  const prisma = deps.prisma ?? getAdminPrisma();
  const actor = await verifyPrepaidAppActor(
    { ...input, subject: input.request, endpoint: '/billing/v1/browser/tariff' },
    { prisma },
  );
  return runBillingSerializableTransaction(
    prisma,
    async (tx) => {
      await lockPrepaidAppSubject(tx, { subject: input.request, actor, credential: input.credential });
      return publicBrowserTariff(
        await activeBrowserPolicy(tx, input.credential.service.id, input.request.project_id),
      );
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}
export async function reserveBrowser(
  input: { request: BillingBrowserReserveRequestV1; credential: VerifiedBillingAppKey; actorToken: string },
  deps: BrowserBillingDependencies = {},
): Promise<BillingBrowserReservationV1> {
  const body = input.request;
  assertBrowserRuntime(input.credential, body.product);
  if (
    !Number.isInteger(body.max_duration_seconds) ||
    body.max_duration_seconds < 60 ||
    body.max_duration_seconds > 1800
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_BROWSER_DURATION_INVALID');
  }
  const context = body.budget_context;
  const issuer = new URL(input.credential.actorIssuer);
  const budgetContext = context
    ? {
        contextId: body.dispatch_id,
        originProduct: body.product,
        originSourceDomain: issuer.hostname + (issuer.pathname === '/' ? '' : issuer.pathname),
        projectId: context.project_id,
        runId: context.run_id,
        runStartedAt: context.run_started_at,
        runOwnerSub: context.run_owner_sub,
        budgetRunId: context.budget_run_id,
        budgetRunStartedAt: context.budget_run_started_at,
        budgetRunOwnerSub: context.budget_run_owner_sub,
      }
    : null;
  if (context?.run_owner_sub && context.run_owner_sub !== body.user_id) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_BROWSER_RUN_OWNER_MISMATCH');
  }
  const prisma = deps.prisma ?? getAdminPrisma();
  const actor = await verifyPrepaidAppActor(
    { ...input, subject: body, endpoint: '/billing/v1/browser/reservations' },
    { prisma },
  );
  const configured = await requireTeamStripeBilling(
    { organisationId: body.organisation_id, teamId: body.team_id },
    prisma,
  );
  // Test credits must never authorize a real, paid provider session.
  if (!configured.livemode) throw new AppError('FORBIDDEN', 403, 'BILLING_BROWSER_LIVE_CREDITS_REQUIRED');
  const account = await resolveStripeAccountContext(
    deps.stripe ?? configured.client,
    configured.livemode,
    prisma,
  );
  const credits = await resolveCreditAccount(
    { account, organisationId: body.organisation_id, teamId: body.team_id },
    { prisma },
  );
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        body.product,
        body.organisation_id,
        body.team_id,
        body.user_id,
        body.project_id,
        body.dispatch_id,
        body.max_duration_seconds,
        actor.tv,
        budgetContext,
      ]),
    )
    .digest('hex');
  return runBillingSerializableTransaction(
    prisma,
    async (tx) => {
      await lockPrepaidAppSubject(tx, { subject: body, actor, credential: input.credential });
      await lockBrowserDispatch(tx, body.dispatch_id);
      if (await tx.billingBrowserCancellation.findUnique({ where: { dispatchId: body.dispatch_id } })) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_DISPATCH_CANCELLED');
      }
      const prior = await tx.billingBrowserReservation.findUnique({
        where: { dispatchId: body.dispatch_id },
      });
      if (prior) {
        if (prior.serviceId !== input.credential.service.id || prior.bindingDigest !== digest) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_BINDING_CONFLICT');
        }
        return publicBrowserReservation(prior);
      }
      const now = deps.now?.() ?? new Date();
      // A minute of headroom reserves provider startup/stop accounting without billing the bound itself.
      const boundMilliseconds = (body.max_duration_seconds + 60) * 1000;
      const policy = await activeBrowserPolicy(
        tx,
        input.credential.service.id,
        body.project_id,
        new Date(now.getTime() + boundMilliseconds + 90_000),
      );
      const rawBound = browserProviderCost(policy, boundMilliseconds);
      const reserved = maximumRatedMicrocredits(rawBound, policy.markupBps);
      const month = now.toISOString().slice(0, 7);
      await reserveBudgetDispatch(tx, {
        dispatchId: body.dispatch_id,
        requestFingerprint: digest,
        startedAt: now,
        product: body.product,
        serviceId: input.credential.service.id,
        providerServiceId: 'browserbase',
        orgId: body.organisation_id,
        teamId: body.team_id,
        userId: body.user_id,
        billingMonth: month,
        currency: 'USD',
        tariffId: `browser-policy:${policy.id}`,
        tariffMode: 'STANDARD',
        markupBps: 1000,
        paymentMode: 'PREPAID',
        rawCostBound: rawBound,
        context: budgetContext,
      });
      const balance = await lockCreditBalance(tx, credits.id);
      if (balance - (await billingReservedMicrocredits(tx, credits.id)) < reserved) {
        throw new AppError('FORBIDDEN', 402, 'BILLING_BROWSER_INSUFFICIENT_CREDITS');
      }
      return publicBrowserReservation(
        await tx.billingBrowserReservation.create({
          data: {
            dispatchId: body.dispatch_id,
            bindingDigest: digest,
            serviceId: input.credential.service.id,
            appKeyId: input.credential.id,
            orgId: body.organisation_id,
            teamId: body.team_id,
            userId: body.user_id,
            actorTokenVersion: actor.tv,
            creditAccountId: credits.id,
            policyId: policy.id,
            projectId: body.project_id,
            maxDurationSeconds: body.max_duration_seconds,
            reservedMicrocredits: reserved,
            claimExpiresAt: new Date(now.getTime() + 90_000),
            billingMonth: month,
          },
        }),
      );
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
    { timeoutMs: 30000 },
  );
}

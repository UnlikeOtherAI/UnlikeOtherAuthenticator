import type { Prisma, BillingBrowserReservation } from '@prisma/client';
import type {
  BillingBrowserReadRequestV1,
  BillingBrowserReleaseRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  assertBrowserRuntime,
  lockBrowserDispatch,
  publicBrowserReservation,
  type BrowserBillingDependencies,
} from './billing-browser-reservation.service.js';
import { lockPrepaidAppCredential, lockPrepaidAppSubject } from './billing-prepaid-app-authority.service.js';
import { assertCurrentFinancialSource } from './billing-financial-source-binding.service.js';
import { releaseBudgetDispatch } from './billing-credit-budget-dispatch.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { browserPaidAccount } from './billing-browser-admission.service.js';
import { assertNessieSeatUsage } from './billing-nessie-seat-access.service.js';

export async function browserReservationRow(
  tx: Prisma.TransactionClient,
  body: BillingBrowserReadRequestV1,
  credential: VerifiedBillingAppKey,
): Promise<BillingBrowserReservation> {
  assertBrowserRuntime(credential, body.product);
  await lockPrepaidAppCredential(tx, credential);
  await lockBrowserDispatch(tx, body.dispatch_id);
  const row = await tx.billingBrowserReservation.findUnique({ where: { dispatchId: body.dispatch_id } });
  if (!row || row.serviceId !== credential.service.id) throw new AppError('NOT_FOUND', 404);
  return row;
}
export async function readBrowserReservation(
  input: { request: BillingBrowserReadRequestV1; credential: VerifiedBillingAppKey },
  deps: BrowserBillingDependencies = {},
) {
  return runBillingSerializableTransaction(
    deps.prisma ?? getAdminPrisma(),
    async (tx) => publicBrowserReservation(await browserReservationRow(tx, input.request, input.credential)),
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}
export async function claimBrowser(
  input: { request: BillingBrowserReadRequestV1; credential: VerifiedBillingAppKey },
  deps: BrowserBillingDependencies = {},
) {
  const prisma = deps.prisma ?? getAdminPrisma();
  assertBrowserRuntime(input.credential, input.request.product);
  const pending = await prisma.billingBrowserReservation.findUnique({ where: { dispatchId: input.request.dispatch_id } });
  if (!pending || pending.serviceId !== input.credential.service.id) throw new AppError('NOT_FOUND', 404);
  // Provider IO stays outside the transaction; immutable payer and account are rechecked before the grant.
  const account = pending.state === 'reserved' ? await browserPaidAccount({ product: input.request.product,
    organisationId: pending.orgId, teamId: pending.teamId }, prisma, deps.stripe) : null;
  return runBillingSerializableTransaction(
    prisma,
    async (tx) => {
      const row = await browserReservationRow(tx, input.request, input.credential);
      // The only response that grants dispatch is the one that wins this transition.
      if (row.state !== 'reserved') return publicBrowserReservation(row);
      const now = deps.now?.() ?? new Date();
      if (row.claimExpiresAt <= now) throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_CLAIM_EXPIRED');
      await lockPrepaidAppSubject(tx, {
        credential: input.credential,
        subject: {
          product: input.request.product,
          organisation_id: row.orgId,
          team_id: row.teamId,
          user_id: row.userId,
        },
        actor: { tv: row.actorTokenVersion, exp: Math.floor(row.claimExpiresAt.getTime() / 1000) },
      });
      const wallet = await tx.billingCreditAccount.findUniqueOrThrow({ where: { id: row.creditAccountId } });
      if (!account || account.id !== wallet.accountId) throw new AppError('FORBIDDEN', 403, 'BILLING_BROWSER_LIVE_CREDITS_REQUIRED');
      await assertNessieSeatUsage(tx, { product: input.request.product, serviceId: row.serviceId,
        organisationId: row.orgId, teamId: row.teamId, userId: row.userId });
      const hold = await tx.billingCreditBudgetDispatch.findUniqueOrThrow({
        where: { dispatchId: row.dispatchId },
      });
      await assertCurrentFinancialSource(tx, hold);
      const policy = await tx.billingBrowserPolicy.findUniqueOrThrow({ where: { id: row.policyId } });
      if (
        policy.retiredAt ||
        policy.validUntil.getTime() <= now.getTime() + (row.maxDurationSeconds + 60) * 1000
      ) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_BROWSER_TARIFF_UNAVAILABLE');
      }
      return publicBrowserReservation(
        await tx.billingBrowserReservation.update({
          where: { id: row.id },
          data: {
            state: 'dispatching',
            dispatchClaimedAt: now,
          },
        }),
        true,
      );
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}
/** The runtime supplies durable proof of no session; the fence defeats a delayed reserve. */
export async function releaseBrowserReservation(
  input: { request: BillingBrowserReleaseRequestV1; credential: VerifiedBillingAppKey },
  deps: BrowserBillingDependencies = {},
) {
  return runBillingSerializableTransaction(
    deps.prisma ?? getAdminPrisma(),
    async (tx) => {
      assertBrowserRuntime(input.credential, input.request.product);
      await lockPrepaidAppCredential(tx, input.credential);
      await lockBrowserDispatch(tx, input.request.dispatch_id);
      if (
        input.request.proof !== 'no_provider_dispatch' &&
        (input.request.proof !== 'provider_rejected' ||
          ![400, 401, 403, 404, 422, 429].includes(input.request.provider_http_status))
      ) {
        throw new AppError('BAD_REQUEST', 400);
      }
      const row = await tx.billingBrowserReservation.findUnique({
        where: { dispatchId: input.request.dispatch_id },
      });
      const cancelled = await tx.billingBrowserCancellation.findUnique({
        where: { dispatchId: input.request.dispatch_id },
      });
      if (
        (row && row.serviceId !== input.credential.service.id) ||
        (cancelled && cancelled.serviceId !== input.credential.service.id)
      ) {
        throw new AppError('NOT_FOUND', 404);
      }
      if (row && (!['reserved', 'dispatching', 'released'].includes(row.state) || row.providerSessionId)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_OUTCOME_UNPROVEN');
      }
      if (!cancelled)
        await tx.billingBrowserCancellation.create({
          data: {
            dispatchId: input.request.dispatch_id,
            serviceId: input.credential.service.id,
            proof: input.request.proof,
            providerHttpStatus:
              input.request.proof === 'provider_rejected' ? input.request.provider_http_status : null,
          },
        });
      if (row && row.state !== 'released') {
        await releaseBudgetDispatch(tx, row.dispatchId);
        await tx.billingBrowserReservation.update({ where: { id: row.id }, data: { state: 'released' } });
      }
      return { dispatch_id: input.request.dispatch_id, released: true as const };
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}

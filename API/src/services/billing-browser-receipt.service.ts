import type { BillingBrowserReceiptRequestV1 } from '@unlikeotherai/billing-statement-protocol';
import { paidExceptionEvidenceDigest } from './billing-paid-usage-exception.service.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { browserReservationRow } from './billing-browser-dispatch.service.js';
import { browserProviderCost } from './billing-browser-policy.service.js';
import {
  publicBrowserReservation,
  type BrowserBillingDependencies,
} from './billing-browser-reservation.service.js';
import { recordPaidUsageLiability } from './billing-paid-liability.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';

/** The credential is the trusted receipt producer; the public client cannot supply timing or amounts. */
export async function settleBrowser(
  input: { request: BillingBrowserReceiptRequestV1; credential: VerifiedBillingAppKey },
  deps: BrowserBillingDependencies = {},
) {
  const body = input.request;
  const started = new Date(body.started_at),
    ended = new Date(body.ended_at);
  const milliseconds = ended.getTime() - started.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    !Number.isSafeInteger(body.proxy_bytes) ||
    body.proxy_bytes < 0 ||
    !['COMPLETED', 'ERROR', 'TIMED_OUT'].includes(body.status)
  )
    throw new AppError('BAD_REQUEST', 400);
  return runBillingSerializableTransaction(
    deps.prisma ?? getAdminPrisma(),
    async (tx) => {
      const row = await browserReservationRow(tx, body, input.credential);
      if (
        !row.dispatchClaimedAt ||
        row.state === 'released' ||
        row.projectId !== body.project_id ||
        (row.providerSessionId && row.providerSessionId !== body.session_id) ||
        started.getTime() < row.dispatchClaimedAt.getTime() - 5000 ||
        ended > (deps.now?.() ?? new Date())
      ) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_RECEIPT_CONFLICT');
      }
      const policy = await tx.billingBrowserPolicy.findUniqueOrThrow({ where: { id: row.policyId } });
      const actual = browserProviderCost(policy, milliseconds);
      if (row.providerSessionId) {
        if (
          !row.actualAmount?.eq(actual) ||
          row.providerStartedAt?.getTime() !== started.getTime() ||
          row.providerEndedAt?.getTime() !== ended.getTime() ||
          row.proxyBytes !== BigInt(body.proxy_bytes) ||
          row.providerStatus !== body.status
        ) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_RECEIPT_CHANGED');
        }
        return publicBrowserReservation(row);
      }
      const evidence = {
        providerSessionId: body.session_id,
        providerStartedAt: started,
        providerEndedAt: ended,
        providerStatus: body.status,
        proxyBytes: BigInt(body.proxy_bytes),
        actualDurationMilliseconds: BigInt(milliseconds),
      };
      // Proxies are disabled at creation. Unexpected fees or duration retain the entire hold for reconciliation.
      if (body.proxy_bytes !== 0 || milliseconds > (row.maxDurationSeconds + 60) * 1000) {
        const reconciled = await tx.billingBrowserReservation.update({
          where: { id: row.id },
          data: { ...evidence, state: 'reconciliation', actualAmount: actual },
        });
        const hold = await tx.billingCreditBudgetDispatch.findUniqueOrThrow({
          where: { dispatchId: row.dispatchId },
        });
        await tx.billingPaidUsageException.create({
          data: {
            dispatchId: row.dispatchId,
            receiptId: body.session_id,
            appKeyId: row.appKeyId,
            evidenceDigest: paidExceptionEvidenceDigest({
              dispatchId: row.dispatchId,
              receiptId: body.session_id,
              actual,
              currency: 'USD',
              requestFingerprint: row.bindingDigest,
              rawCostBound: browserProviderCost(policy, (row.maxDurationSeconds + 60) * 1000),
              contextDigest: hold.contextDigest,
            }),
            rawCostActual: actual,
            currency: 'USD',
          },
        });
        return publicBrowserReservation(reconciled);
      }
      const balance = await lockCreditBalance(tx, row.creditAccountId);
      const liability = await recordPaidUsageLiability(tx, {
        dispatchId: row.dispatchId,
        receiptId: body.session_id,
        actual,
        creditAccountId: row.creditAccountId,
      });
      const debit = liability.ratedMicrocredits;
      if (debit > row.reservedMicrocredits || debit > balance)
        throw new AppError('BAD_REQUEST', 409, 'BILLING_BROWSER_RECEIPT_EXCEEDS_HOLD');
      const settled = await tx.billingBrowserReservation.update({
        where: { id: row.id },
        data: {
          ...evidence,
          state: 'settled',
          actualAmount: actual,
          debitedMicrocredits: debit,
        },
      });
      if (debit > 0n)
        await tx.billingCreditEntry.create({
          data: {
            creditAccountId: row.creditAccountId,
            serviceId: row.serviceId,
            appKeyId: input.credential.id,
            attributedUserId: row.userId,
            kind: 'BROWSER_PREPAID_USAGE',
            direction: 'DEBIT',
            amountMicrocredits: debit,
            balanceAfterMicrocredits: balance - debit,
            currency: 'USD',
            occurredAt: row.createdAt,
            sourceType: 'browser_provider_receipt',
            sourceId: row.id,
            browserReservationId: row.id,
            idempotencyKey: `browser-receipt:${body.session_id}`,
          },
        });
      return publicBrowserReservation(settled);
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
    { timeoutMs: 30000 },
  );
}

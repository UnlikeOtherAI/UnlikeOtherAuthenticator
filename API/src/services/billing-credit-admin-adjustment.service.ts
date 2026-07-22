import { randomUUID } from 'node:crypto';

import {
  BillingCreditAutoTopUpAttemptStatus,
  BillingCreditAutoTopUpState,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog } from './audit-log.service.js';
import {
  adminCreditAccountSelection,
  adminCreditAccountView,
  adminCreditAdjustmentSelection,
  adminCreditAdjustmentView,
  readAdminCreditAccount,
  type AdminCreditAccountRow,
  type AdminCreditAccountView,
  type AdminCreditAdjustmentView,
} from './billing-credit-admin-account.service.js';
import {
  adminCreditResultingBalance,
  normalizeAdminCreditAdjustmentIntent,
  parseAdminCreditValue,
  resolveAdminCreditAdjustmentContext,
  type AdminCreditActor,
  type AdminCreditAdjustmentIntent,
} from './billing-credit-admin-adjustment-input.service.js';
import {
  signCreditAdjustmentConfirmation,
  verifyCreditAdjustmentConfirmation,
  type CreditAdjustmentTokenSnapshot,
} from './billing-credit-admin-adjustment-token.service.js';
import { lockCreditAccountAgainstAutoTopUp } from './billing-credit-balance-lock.service.js';
import { billingCreditAmount } from './billing-credit-display.service.js';

const OPEN_ATTEMPT_STATUSES = [
  BillingCreditAutoTopUpAttemptStatus.PENDING,
  BillingCreditAutoTopUpAttemptStatus.PROCESSING,
  BillingCreditAutoTopUpAttemptStatus.REQUIRES_ACTION,
  BillingCreditAutoTopUpAttemptStatus.NEEDS_REVIEW,
] as const;

type ServiceDependencies = {
  prisma?: PrismaClient;
  adminDomain?: string;
  confirmationSecret?: string;
  now?: () => Date;
  createId?: () => string;
  lockAccount?: typeof lockCreditAccountAgainstAutoTopUp;
  afterAccountLock?: () => Promise<void>;
};

export type { AdminCreditAdjustmentIntent } from './billing-credit-admin-adjustment-input.service.js';

export type AdminCreditAutoTopUpPreview = {
  generation: number;
  state: 'disabled' | 'active' | 'paused' | 'requires_action' | 'needs_review';
  threshold_credits: ReturnType<typeof billingCreditAmount> | null;
  refill_credits: ReturnType<typeof billingCreditAmount> | null;
  consequence: {
    code:
      | 'not_active'
      | 'configuration_incomplete'
      | 'remains_above_threshold'
      | 'crosses_below_threshold'
      | 'remains_below_threshold'
      | 'crosses_above_threshold';
    message: string;
  };
};

export type AdminCreditAdjustmentPreview = {
  account: AdminCreditAccountView;
  current_credits: ReturnType<typeof billingCreditAmount>;
  signed_credits: ReturnType<typeof billingCreditAmount>;
  resulting_credits: ReturnType<typeof billingCreditAmount>;
  reason: string;
  idempotency_key: string;
  automatic_top_up: AdminCreditAutoTopUpPreview;
  expires_at: string;
  confirmation_token: string;
};

function isRetryableTransactionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return (
    candidate?.code === 'P2034' ||
    candidate?.code === 'P2002' ||
    (candidate?.code === 'P2010' && candidate.meta?.code === '40001')
  );
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function autoTopUpPreview(
  account: AdminCreditAccountRow,
  current: bigint,
  resulting: bigint,
): AdminCreditAutoTopUpPreview {
  const state = account.autoTopUpState.toLowerCase() as AdminCreditAutoTopUpPreview['state'];
  const threshold = account.autoTopUpThresholdMicrocredits;
  const refill = account.autoTopUpConsentRevision?.refillCreditsMicrocredits ?? null;
  let code: AdminCreditAutoTopUpPreview['consequence']['code'];
  if (account.autoTopUpState !== BillingCreditAutoTopUpState.ACTIVE) code = 'not_active';
  else if (threshold === null || refill === null) code = 'configuration_incomplete';
  else if (current >= threshold && resulting >= threshold) code = 'remains_above_threshold';
  else if (current >= threshold && resulting < threshold) code = 'crosses_below_threshold';
  else if (current < threshold && resulting < threshold) code = 'remains_below_threshold';
  else code = 'crosses_above_threshold';
  const messages: Record<typeof code, string> = {
    not_active: 'Automatic top-up is not active, so this adjustment will not trigger it.',
    configuration_incomplete:
      'Automatic top-up is active but its threshold or refill is unavailable. Posting is blocked if an attempt appears.',
    remains_above_threshold:
      'The resulting balance remains at or above the automatic top-up threshold.',
    crosses_below_threshold:
      'The resulting balance falls below the threshold, so the configured refill may be scheduled after this adjustment commits.',
    remains_below_threshold:
      'The resulting balance remains below the threshold, so the configured refill may be scheduled after this adjustment commits.',
    crosses_above_threshold:
      'The resulting balance moves to or above the threshold, so this balance will not start a new automatic top-up.',
  };
  return {
    generation: account.autoTopUpGeneration,
    state,
    threshold_credits: threshold === null ? null : billingCreditAmount(threshold),
    refill_credits: refill === null ? null : billingCreditAmount(refill),
    consequence: { code, message: messages[code] },
  };
}

function tokenAutoTopUp(value: AdminCreditAutoTopUpPreview) {
  return {
    generation: value.generation,
    state: value.state,
    threshold_credits: value.threshold_credits?.credits ?? null,
    refill_credits: value.refill_credits?.credits ?? null,
    consequence: value.consequence.code,
  };
}

async function lockAndRead(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
  deps: ServiceDependencies,
): Promise<{ account: AdminCreditAccountRow; balance: bigint }> {
  const balance = await (deps.lockAccount ?? lockCreditAccountAgainstAutoTopUp)(
    tx,
    creditAccountId,
  );
  if (balance === null) throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_NOT_FOUND');
  await deps.afterAccountLock?.();
  const account = await tx.billingCreditAccount.findUnique({
    where: { id: creditAccountId },
    select: adminCreditAccountSelection,
  });
  if (!account || account.balanceMicrocredits !== balance) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_STALE');
  }
  return { account, balance };
}

async function rejectUnresolvedAutoTopUp(
  tx: Prisma.TransactionClient,
  creditAccountId: string,
): Promise<void> {
  const unresolved = await tx.billingCreditAutoTopUpAttempt.findFirst({
    where: { creditAccountId, status: { in: [...OPEN_ATTEMPT_STATUSES] } },
    select: { id: true },
  });
  if (unresolved) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_AUTO_TOP_UP_PENDING');
  }
}

function assertScope(
  account: AdminCreditAccountRow,
  expected: { organisationId: string; teamId: string; mode?: 'test' | 'live' },
): void {
  const mode = account.account.livemode ? 'live' : 'test';
  if (
    account.orgId !== expected.organisationId ||
    account.teamId !== expected.teamId ||
    account.currency !== 'USD' ||
    (expected.mode !== undefined && mode !== expected.mode)
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
  }
}

async function lockedTransaction<T>(
  prisma: PrismaClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(run, {
        // READ COMMITTED is intentional: a transaction that waited for the shared
        // advisory lock must see the scheduler attempt committed by the lock winner.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_ADJUSTMENT_RETRY_EXHAUSTED');
}

export async function previewAdminCreditAdjustment(
  input: AdminCreditAdjustmentIntent,
  deps: ServiceDependencies = {},
): Promise<AdminCreditAdjustmentPreview> {
  const value = normalizeAdminCreditAdjustmentIntent(input);
  const context = resolveAdminCreditAdjustmentContext(deps);
  const prisma = deps.prisma ?? getAdminPrisma();
  const snapshot = await lockedTransaction(prisma, async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.admin_auth_domain', ${context.domain}, true)`,
    );
    const locked = await lockAndRead(tx, value.creditAccountId, deps);
    assertScope(locked.account, value);
    await rejectUnresolvedAutoTopUp(tx, value.creditAccountId);
    const resulting = adminCreditResultingBalance(locked.balance, value.signedAmountMicrocredits);
    const automaticTopUp = autoTopUpPreview(locked.account, locked.balance, resulting);
    return {
      account: adminCreditAccountView(locked.account),
      current: locked.balance,
      resulting,
      automaticTopUp,
    };
  });
  const tokenSnapshot: CreditAdjustmentTokenSnapshot = {
    actor_user_id: value.userId,
    actor_email: value.email,
    admin_domain: context.domain,
    credit_account_id: value.creditAccountId,
    organisation_id: value.organisationId,
    team_id: value.teamId,
    mode: snapshot.account.mode,
    current_credits: billingCreditAmount(snapshot.current).credits,
    resulting_credits: billingCreditAmount(snapshot.resulting).credits,
    signed_credits: billingCreditAmount(value.signedAmountMicrocredits).credits,
    reason: value.reason,
    idempotency_key: value.idempotencyKey,
    automatic_top_up: tokenAutoTopUp(snapshot.automaticTopUp),
  };
  const signed = await signCreditAdjustmentConfirmation({
    snapshot: tokenSnapshot,
    secret: context.secret,
    audience: context.domain,
    now: deps.now?.(),
  });
  return {
    account: snapshot.account,
    current_credits: billingCreditAmount(snapshot.current),
    signed_credits: billingCreditAmount(value.signedAmountMicrocredits),
    resulting_credits: billingCreditAmount(snapshot.resulting),
    reason: value.reason,
    idempotency_key: value.idempotencyKey,
    automatic_top_up: snapshot.automaticTopUp,
    ...signed,
  };
}

export async function createAdminCreditAdjustment(
  input: { creditAccountId: string; confirmationToken: string; actor: AdminCreditActor },
  deps: ServiceDependencies = {},
): Promise<{
  account: AdminCreditAccountView;
  adjustment: AdminCreditAdjustmentView;
  replayed: boolean;
}> {
  const creditAccountId = input.creditAccountId.trim();
  const token = input.confirmationToken.trim();
  const actor = { userId: input.actor.userId.trim(), email: input.actor.email.trim() };
  if (!creditAccountId || !token || token.length > 12_000 || !actor.userId || !actor.email) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_INVALID');
  }
  const context = resolveAdminCreditAdjustmentContext(deps);
  const verified = await verifyCreditAdjustmentConfirmation({
    token,
    secret: context.secret,
    audience: context.domain,
    now: deps.now?.(),
  });
  if (
    verified.credit_account_id !== creditAccountId ||
    verified.actor_user_id !== actor.userId ||
    verified.actor_email.toLowerCase() !== actor.email.toLowerCase() ||
    normalizeDomain(verified.admin_domain) !== context.domain
  ) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_INVALID');
  }
  const delta = parseAdminCreditValue(verified.signed_credits, false);
  const tokenCurrent = parseAdminCreditValue(verified.current_credits);
  const tokenResulting = parseAdminCreditValue(verified.resulting_credits);
  const prisma = deps.prisma ?? getAdminPrisma();
  try {
    return await lockedTransaction(prisma, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.admin_auth_domain', ${context.domain}, true)`,
      );
      const locked = await lockAndRead(tx, creditAccountId, deps);
      assertScope(locked.account, {
        organisationId: verified.organisation_id,
        teamId: verified.team_id,
        mode: verified.mode,
      });
      const existing = await tx.billingCreditAdminAdjustment.findUnique({
        where: {
          creditAccountId_idempotencyKey: {
            creditAccountId,
            idempotencyKey: verified.idempotency_key,
          },
        },
        select: {
          ...adminCreditAdjustmentSelection,
          creditEntry: { select: { balanceAfterMicrocredits: true } },
        },
      });
      if (existing) {
        const exactReplay =
          existing.signedAmountMicrocredits === delta &&
          existing.reason === verified.reason &&
          existing.createdByUserId === actor.userId &&
          existing.createdByEmail.toLowerCase() === actor.email.toLowerCase() &&
          normalizeDomain(existing.createdByAdminDomain) === context.domain &&
          tokenCurrent + delta === tokenResulting &&
          existing.creditEntry.balanceAfterMicrocredits === tokenResulting;
        if (!exactReplay) {
          throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
        }
        return {
          account: adminCreditAccountView(await readAdminCreditAccount(tx, creditAccountId)),
          adjustment: adminCreditAdjustmentView(existing),
          replayed: true,
        };
      }
      await rejectUnresolvedAutoTopUp(tx, creditAccountId);
      const resulting = adminCreditResultingBalance(locked.balance, delta);
      const automaticTopUp = autoTopUpPreview(locked.account, locked.balance, resulting);
      const expectedAutomaticTopUp = tokenAutoTopUp(automaticTopUp);
      if (
        tokenCurrent !== locked.balance ||
        tokenResulting !== resulting ||
        JSON.stringify(verified.automatic_top_up) !== JSON.stringify(expectedAutomaticTopUp)
      ) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_CONFIRMATION_STALE');
      }
      const occupiedEntry = await tx.billingCreditEntry.findUnique({
        where: {
          creditAccountId_idempotencyKey: {
            creditAccountId,
            idempotencyKey: verified.idempotency_key,
          },
        },
        select: { id: true },
      });
      if (occupiedEntry) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
      }
      const adjustmentId = `bca_${(deps.createId ?? randomUUID)()}`;
      const entryId = `bce_${(deps.createId ?? randomUUID)()}`;
      const adjustment = await tx.billingCreditAdminAdjustment.create({
        data: {
          id: adjustmentId,
          accountId: locked.account.accountId,
          creditAccountId,
          orgId: verified.organisation_id,
          teamId: verified.team_id,
          signedAmountMicrocredits: delta,
          reason: verified.reason,
          idempotencyKey: verified.idempotency_key,
          createdByUserId: actor.userId,
          createdByEmail: actor.email,
          createdByAdminDomain: context.domain,
          creditEntryId: entryId,
        },
        select: adminCreditAdjustmentSelection,
      });
      await tx.billingCreditEntry.create({
        data: {
          id: entryId,
          creditAccountId,
          direction:
            delta > 0n ? BillingCreditEntryDirection.CREDIT : BillingCreditEntryDirection.DEBIT,
          kind: BillingCreditEntryKind.ADJUSTMENT,
          amountMicrocredits: delta > 0n ? delta : -delta,
          balanceAfterMicrocredits: resulting,
          currency: 'USD',
          idempotencyKey: verified.idempotency_key,
          sourceType: 'credit_admin_adjustment',
          sourceId: adjustmentId,
          occurredAt: deps.now?.() ?? new Date(),
        },
      });
      await writeAuditLog(
        {
          actorEmail: actor.email,
          action: 'billing.credit_adjustment_created',
          metadata: {
            adjustment_id: adjustmentId,
            credit_account_id: creditAccountId,
            organisation_id: verified.organisation_id,
            team_id: verified.team_id,
            mode: verified.mode,
            current_credits: billingCreditAmount(locked.balance),
            signed_credits: billingCreditAmount(delta),
            resulting_credits: billingCreditAmount(resulting),
            reason: verified.reason,
            idempotency_key: verified.idempotency_key,
            automatic_top_up: automaticTopUp,
          },
        },
        { prisma: tx },
      );
      return {
        account: adminCreditAccountView(await readAdminCreditAccount(tx, creditAccountId)),
        adjustment: adminCreditAdjustmentView(adjustment),
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
    }
    throw error;
  }
}

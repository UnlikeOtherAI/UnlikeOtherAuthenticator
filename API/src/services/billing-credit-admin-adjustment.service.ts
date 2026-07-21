import { randomUUID } from 'node:crypto';

import {
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog } from './audit-log.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { billingCreditAmount } from './billing-credit-display.service.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MICRO_CREDITS_PER_CREDIT = 1_000_000n;
const CREDIT_INPUT_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,5})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const adjustmentSelection = {
  id: true,
  signedAmountMicrocredits: true,
  reason: true,
  idempotencyKey: true,
  createdByUserId: true,
  createdByEmail: true,
  createdByAdminDomain: true,
  createdAt: true,
} satisfies Prisma.BillingCreditAdminAdjustmentSelect;

const accountSelection = {
  id: true,
  accountId: true,
  orgId: true,
  teamId: true,
  currency: true,
  balanceMicrocredits: true,
  updatedAt: true,
  account: { select: { livemode: true } },
  org: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  adminAdjustments: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 20,
    select: adjustmentSelection,
  },
} satisfies Prisma.BillingCreditAccountSelect;

type CreditAccountRow = Prisma.BillingCreditAccountGetPayload<{ select: typeof accountSelection }>;
type CreditAdjustmentRow = Prisma.BillingCreditAdminAdjustmentGetPayload<{
  select: typeof adjustmentSelection;
}>;

export type AdminCreditAdjustmentView = {
  id: string;
  signed_credits: ReturnType<typeof billingCreditAmount>;
  reason: string;
  idempotency_key: string;
  created_by: { user_id: string; email: string; admin_domain: string };
  created_at: string;
};

export type AdminCreditAccountView = {
  id: string;
  organisation: { id: string; name: string };
  team: { id: string; name: string };
  mode: 'test' | 'live';
  remaining_credits: ReturnType<typeof billingCreditAmount>;
  updated_at: string;
  recent_adjustments: AdminCreditAdjustmentView[];
};

type ServiceDependencies = {
  prisma?: PrismaClient;
  adminDomain?: string;
  now?: () => Date;
  createId?: () => string;
  lockBalance?: typeof lockCreditBalance;
};

export type CreateAdminCreditAdjustmentInput = {
  creditAccountId: string;
  organisationId: string;
  teamId: string;
  signedCredits: string;
  reason: string;
  idempotencyKey: string;
  actor: { userId: string; email: string };
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

function parseSignedCredits(input: string): bigint {
  const value = input.trim();
  if (value.length > 40 || !CREDIT_INPUT_PATTERN.test(value)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const microcredits =
    BigInt(whole) * MICRO_CREDITS_PER_CREDIT + BigInt(fraction.padEnd(6, '0') || '0');
  const signed = negative ? -microcredits : microcredits;
  if (signed === 0n || signed < -MAX_INT64 || signed > MAX_INT64 || signed % 10n !== 0n) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_AMOUNT_INVALID');
  }
  return signed;
}

function normalizeInput(input: CreateAdminCreditAdjustmentInput) {
  const creditAccountId = input.creditAccountId.trim();
  const organisationId = input.organisationId.trim();
  const teamId = input.teamId.trim();
  const reason = input.reason.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const userId = input.actor.userId.trim();
  const email = input.actor.email.trim();
  if (
    !creditAccountId ||
    !organisationId ||
    !teamId ||
    !userId ||
    !email ||
    email.length > 320 ||
    !reason ||
    reason.length > 1000 ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_INVALID');
  }
  return {
    creditAccountId,
    organisationId,
    teamId,
    reason,
    idempotencyKey,
    userId,
    email,
    signedAmountMicrocredits: parseSignedCredits(input.signedCredits),
  };
}

function adjustmentView(row: CreditAdjustmentRow): AdminCreditAdjustmentView {
  return {
    id: row.id,
    signed_credits: billingCreditAmount(row.signedAmountMicrocredits),
    reason: row.reason,
    idempotency_key: row.idempotencyKey,
    created_by: {
      user_id: row.createdByUserId,
      email: row.createdByEmail,
      admin_domain: row.createdByAdminDomain,
    },
    created_at: row.createdAt.toISOString(),
  };
}

function accountView(row: CreditAccountRow): AdminCreditAccountView {
  return {
    id: row.id,
    organisation: row.org,
    team: row.team,
    mode: row.account.livemode ? 'live' : 'test',
    remaining_credits: billingCreditAmount(row.balanceMicrocredits),
    updated_at: row.updatedAt.toISOString(),
    recent_adjustments: row.adminAdjustments.map(adjustmentView),
  };
}

async function readAccount(
  prisma: Pick<Prisma.TransactionClient, 'billingCreditAccount'>,
  creditAccountId: string,
): Promise<CreditAccountRow> {
  const account = await prisma.billingCreditAccount.findUnique({
    where: { id: creditAccountId },
    select: accountSelection,
  });
  if (!account) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_NOT_FOUND');
  }
  return account;
}

export async function listAdminCreditAccounts(
  params: { organisationId?: string; teamId?: string; limit?: number } = {},
  deps: ServiceDependencies = {},
): Promise<AdminCreditAccountView[]> {
  const organisationId = params.organisationId?.trim();
  const teamId = params.teamId?.trim();
  const limit = params.limit ?? 50;
  if (
    (params.organisationId !== undefined && !organisationId) ||
    (params.teamId !== undefined && !teamId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ACCOUNT_QUERY_INVALID');
  }
  const rows = await (deps.prisma ?? getAdminPrisma()).billingCreditAccount.findMany({
    where: {
      ...(organisationId ? { orgId: organisationId } : {}),
      ...(teamId ? { teamId } : {}),
      currency: 'USD',
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: accountSelection,
  });
  return rows.map(accountView);
}

export async function createAdminCreditAdjustment(
  input: CreateAdminCreditAdjustmentInput,
  deps: ServiceDependencies = {},
): Promise<{
  account: AdminCreditAccountView;
  adjustment: AdminCreditAdjustmentView;
  replayed: boolean;
}> {
  const value = normalizeInput(input);
  const prisma = deps.prisma ?? getAdminPrisma();
  const adminDomain = normalizeDomain(deps.adminDomain ?? getAdminAuthDomain(getEnv()));
  if (!adminDomain) {
    throw new AppError('INTERNAL', 500, 'ADMIN_AUTH_DOMAIN_REQUIRED');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)`,
          );
          const balance = await (deps.lockBalance ?? lockCreditBalance)(tx, value.creditAccountId);
          const scopedAccount = await tx.billingCreditAccount.findUnique({
            where: { id: value.creditAccountId },
            select: { accountId: true, orgId: true, teamId: true, currency: true },
          });
          if (!scopedAccount) {
            throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_NOT_FOUND');
          }
          if (
            scopedAccount.orgId !== value.organisationId ||
            scopedAccount.teamId !== value.teamId ||
            scopedAccount.currency !== 'USD'
          ) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
          }

          const existing = await tx.billingCreditAdminAdjustment.findUnique({
            where: {
              creditAccountId_idempotencyKey: {
                creditAccountId: value.creditAccountId,
                idempotencyKey: value.idempotencyKey,
              },
            },
            select: adjustmentSelection,
          });
          if (existing) {
            const exactReplay =
              existing.signedAmountMicrocredits === value.signedAmountMicrocredits &&
              existing.reason === value.reason &&
              existing.createdByUserId === value.userId &&
              existing.createdByEmail.toLowerCase() === value.email.toLowerCase() &&
              normalizeDomain(existing.createdByAdminDomain) === adminDomain;
            if (!exactReplay) {
              throw new AppError(
                'BAD_REQUEST',
                409,
                'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT',
              );
            }
            return {
              account: accountView(await readAccount(tx, value.creditAccountId)),
              adjustment: adjustmentView(existing),
              replayed: true,
            };
          }

          const occupiedEntry = await tx.billingCreditEntry.findUnique({
            where: {
              creditAccountId_idempotencyKey: {
                creditAccountId: value.creditAccountId,
                idempotencyKey: value.idempotencyKey,
              },
            },
            select: { id: true },
          });
          if (occupiedEntry) {
            throw new AppError(
              'BAD_REQUEST',
              409,
              'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT',
            );
          }

          const nextBalance = balance + value.signedAmountMicrocredits;
          if (nextBalance < MIN_INT64 || nextBalance > MAX_INT64) {
            throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ADJUSTMENT_BALANCE_INVALID');
          }
          if (value.signedAmountMicrocredits < 0n && nextBalance < 0n) {
            throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_INSUFFICIENT');
          }

          const adjustmentId = `bca_${(deps.createId ?? randomUUID)()}`;
          const entryId = `bce_${(deps.createId ?? randomUUID)()}`;
          const occurredAt = (deps.now ?? (() => new Date()))();
          const adjustment = await tx.billingCreditAdminAdjustment.create({
            data: {
              id: adjustmentId,
              accountId: scopedAccount.accountId,
              creditAccountId: value.creditAccountId,
              orgId: value.organisationId,
              teamId: value.teamId,
              signedAmountMicrocredits: value.signedAmountMicrocredits,
              reason: value.reason,
              idempotencyKey: value.idempotencyKey,
              createdByUserId: value.userId,
              createdByEmail: value.email,
              createdByAdminDomain: adminDomain,
              creditEntryId: entryId,
            },
            select: adjustmentSelection,
          });
          await tx.billingCreditEntry.create({
            data: {
              id: entryId,
              creditAccountId: value.creditAccountId,
              direction:
                value.signedAmountMicrocredits > 0n
                  ? BillingCreditEntryDirection.CREDIT
                  : BillingCreditEntryDirection.DEBIT,
              kind: BillingCreditEntryKind.ADJUSTMENT,
              amountMicrocredits:
                value.signedAmountMicrocredits > 0n
                  ? value.signedAmountMicrocredits
                  : -value.signedAmountMicrocredits,
              balanceAfterMicrocredits: nextBalance,
              currency: 'USD',
              idempotencyKey: value.idempotencyKey,
              sourceType: 'credit_admin_adjustment',
              sourceId: adjustmentId,
              occurredAt,
            },
          });
          await writeAuditLog(
            {
              actorEmail: value.email,
              action: 'billing.credit_adjustment_created',
              metadata: {
                adjustment_id: adjustmentId,
                credit_account_id: value.creditAccountId,
                organisation_id: value.organisationId,
                team_id: value.teamId,
                signed_credits: billingCreditAmount(value.signedAmountMicrocredits),
                remaining_credits: billingCreditAmount(nextBalance),
                reason: value.reason,
                idempotency_key: value.idempotencyKey,
              },
            },
            { prisma: tx },
          );
          return {
            account: accountView(await readAccount(tx, value.creditAccountId)),
            adjustment: adjustmentView(adjustment),
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < 2) continue;
      if (isUniqueConflict(error)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }
  throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_ADJUSTMENT_RETRY_EXHAUSTED');
}

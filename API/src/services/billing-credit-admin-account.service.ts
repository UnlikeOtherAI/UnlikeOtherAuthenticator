import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { billingCreditAmount } from './billing-credit-display.service.js';

export const adminCreditAdjustmentSelection = {
  id: true,
  signedAmountMicrocredits: true,
  reason: true,
  idempotencyKey: true,
  createdByUserId: true,
  createdByEmail: true,
  createdByAdminDomain: true,
  createdAt: true,
} satisfies Prisma.BillingCreditAdminAdjustmentSelect;

export const adminCreditAccountSelection = {
  id: true,
  accountId: true,
  orgId: true,
  teamId: true,
  currency: true,
  balanceMicrocredits: true,
  autoTopUpGeneration: true,
  autoTopUpState: true,
  autoTopUpThresholdMicrocredits: true,
  updatedAt: true,
  account: { select: { livemode: true } },
  org: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  autoTopUpConsentRevision: { select: { refillCreditsMicrocredits: true } },
  adminAdjustments: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 20,
    select: adminCreditAdjustmentSelection,
  },
} satisfies Prisma.BillingCreditAccountSelect;

export type AdminCreditAccountRow = Prisma.BillingCreditAccountGetPayload<{
  select: typeof adminCreditAccountSelection;
}>;
export type AdminCreditAdjustmentRow = Prisma.BillingCreditAdminAdjustmentGetPayload<{
  select: typeof adminCreditAdjustmentSelection;
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

export type AdminCreditAccountPage = {
  accounts: AdminCreditAccountView[];
  next_cursor: string | null;
  has_more: boolean;
};

const CursorSchema = z
  .object({
    updated_at: z.string().datetime(),
    id: z.string().min(1).max(256),
    search: z.string().max(256).nullable(),
  })
  .strict();

export function adminCreditAdjustmentView(
  row: AdminCreditAdjustmentRow,
): AdminCreditAdjustmentView {
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

export function adminCreditAccountView(row: AdminCreditAccountRow): AdminCreditAccountView {
  return {
    id: row.id,
    organisation: row.org,
    team: row.team,
    mode: row.account.livemode ? 'live' : 'test',
    remaining_credits: billingCreditAmount(row.balanceMicrocredits),
    updated_at: row.updatedAt.toISOString(),
    recent_adjustments: row.adminAdjustments.map(adminCreditAdjustmentView),
  };
}

function encodeCursor(row: AdminCreditAccountRow, search: string | undefined): string {
  return Buffer.from(
    JSON.stringify({
      updated_at: row.updatedAt.toISOString(),
      id: row.id,
      search: search ?? null,
    }),
  ).toString('base64url');
}

function decodeCursor(cursor: string, search: string | undefined) {
  try {
    const parsed = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.search !== (search ?? null)) throw new Error('search mismatch');
    return { updatedAt: new Date(parsed.updated_at), id: parsed.id };
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ACCOUNT_CURSOR_INVALID');
  }
}

export async function readAdminCreditAccount(
  prisma: Pick<Prisma.TransactionClient, 'billingCreditAccount'>,
  creditAccountId: string,
): Promise<AdminCreditAccountRow> {
  const account = await prisma.billingCreditAccount.findUnique({
    where: { id: creditAccountId },
    select: adminCreditAccountSelection,
  });
  if (!account) throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_NOT_FOUND');
  return account;
}

export async function listAdminCreditAccounts(
  params: {
    organisationId?: string;
    teamId?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  } = {},
  deps: { prisma?: PrismaClient } = {},
): Promise<AdminCreditAccountPage> {
  const organisationId = params.organisationId?.trim();
  const teamId = params.teamId?.trim();
  const search = params.search?.trim();
  const cursorValue = params.cursor?.trim();
  const limit = params.limit ?? 50;
  if (
    (params.organisationId !== undefined && !organisationId) ||
    (params.teamId !== undefined && !teamId) ||
    (params.search !== undefined && (!search || search.length > 256)) ||
    (params.cursor !== undefined && (!cursorValue || cursorValue.length > 1024)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_ACCOUNT_QUERY_INVALID');
  }
  const cursor = cursorValue ? decodeCursor(cursorValue, search) : undefined;
  const exactSearch: Prisma.BillingCreditAccountWhereInput | undefined = search
    ? {
        OR: [
          { id: search },
          { orgId: search },
          { teamId: search },
          { org: { is: { name: { equals: search, mode: 'insensitive' } } } },
          { team: { is: { name: { equals: search, mode: 'insensitive' } } } },
        ],
      }
    : undefined;
  const afterCursor: Prisma.BillingCreditAccountWhereInput | undefined = cursor
    ? {
        OR: [
          { updatedAt: { lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
        ],
      }
    : undefined;
  const rows = await (deps.prisma ?? getAdminPrisma()).billingCreditAccount.findMany({
    where: {
      currency: 'USD',
      ...(organisationId ? { orgId: organisationId } : {}),
      ...(teamId ? { teamId } : {}),
      AND: [exactSearch, afterCursor].filter(
        (value): value is Prisma.BillingCreditAccountWhereInput => value !== undefined,
      ),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: adminCreditAccountSelection,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    accounts: pageRows.map(adminCreditAccountView),
    next_cursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1], search) : null,
    has_more: hasMore,
  };
}

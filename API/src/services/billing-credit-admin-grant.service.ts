import { randomUUID } from 'node:crypto';

import {
  BillingCreditEntryDirection, BillingCreditEntryKind, Prisma, type PrismaClient,
} from '@prisma/client';

import { getAdminAuthDomain } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority, type BillingAdminEffectActor }
  from './billing-admin-effect-authority.service.js';
import { ensureOrganisationCreditAccount } from './billing-credit-account.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { billingReservedMicrocredits } from './billing-credit-holds.service.js';
import { organisationFinancialAccount } from './billing-organisation-financial-account.service.js';
import { resolveOrganisationBillingMode } from './billing-organisation-mode.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';

/**
 * A platform superuser's grant of prepaid credits to an organisation's wallet.
 *
 * The ledger has always admitted this: one `billing_credit_admin_adjustments`
 * row (actor, superuser domain, reason, key) and the one `ADJUSTMENT` CREDIT
 * entry it names, committed together. The database triggers check the pair,
 * apply the balance under the account lock and open a USD credit lot with
 * nothing paid. No checkout, payment, invoice or Stripe object exists for it,
 * so refunds and disputes (which reverse only TOP_UP / AUTOMATIC_TOP_UP
 * entries with Stripe evidence) can never reach it.
 */
export const ADMIN_CREDIT_GRANT_MAX_CREDITS = 10_000_000n;
export const ADMIN_CREDIT_GRANT_REASON_MIN = 12;
export const ADMIN_CREDIT_GRANT_REASON_MAX = 500;
const MICROCREDITS_PER_CREDIT = 1_000_000n;
const MICROCREDITS_PER_USD = 1_000_000_000n;
const CREDITS = /^[1-9]\d{0,7}$/;
const KEY = /^[a-f0-9]{64}$/;
const SOURCE_TYPE = 'credit_admin_adjustment';
const HISTORY_LIMIT = 50;

type Db = PrismaClient;

function decimal(value: bigint, scale: bigint): string {
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function amount(microcredits: bigint) {
  const negative = microcredits < 0n;
  const magnitude = negative ? -microcredits : microcredits;
  const sign = negative ? '-' : '';
  return { microcredits: microcredits.toString(),
    credits: `${sign}${decimal(magnitude, MICROCREDITS_PER_CREDIT)}`,
    usd: `${sign}${decimal(magnitude, MICROCREDITS_PER_USD)}` };
}

/** Whole credits only, so the grant is exact and never below the ledger's 10-microcredit unit. */
export function adminCreditGrantMicrocredits(credits: string): bigint {
  if (!CREDITS.test(credits) || BigInt(credits) > ADMIN_CREDIT_GRANT_MAX_CREDITS) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_GRANT_AMOUNT_INVALID');
  }
  return BigInt(credits) * MICROCREDITS_PER_CREDIT;
}

function ledgerKey(idempotencyKey: string): string {
  return `admin-credit-grant:${idempotencyKey}`;
}

type GrantRow = {
  id: string; orgId: string; signedAmountMicrocredits: bigint; reason: string;
  createdByEmail: string; createdAt: Date; creditEntryId: string;
  creditAccount: { account: { livemode: boolean } };
};

function serializeGrant(row: GrantRow) {
  return { id: row.id, credit_entry_id: row.creditEntryId,
    amount: amount(row.signedAmountMicrocredits), reason: row.reason,
    granted_by: row.createdByEmail, granted_at: row.createdAt.toISOString(),
    mode: row.creditAccount.account.livemode ? 'live' as const : 'sandbox' as const };
}

const grantInclude = { creditAccount: { select: { account: { select: { livemode: true } } } } } as const;

async function organisationWallet(organisationId: string, prisma: Db) {
  const organisation = await prisma.organisation.findFirst({
    where: { id: organisationId, lifecycleStatus: 'ACTIVE' }, select: { id: true, name: true } });
  if (!organisation) throw new AppError('NOT_FOUND', 404, 'BILLING_ORGANISATION_NOT_AVAILABLE');
  const selection = await resolveOrganisationBillingMode(organisationId, prisma);
  const account = await organisationFinancialAccount(selection, prisma);
  if (account.livemode !== (selection.mode === 'live')) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ACCOUNT_MODE_MISMATCH');
  }
  return { organisation, selection, account };
}

/** The organisation's current wallet and the grants made to it; reading creates nothing. */
export async function readOrganisationCreditGrants(organisationId: string, deps?: { prisma?: Db }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { organisation, selection, account } = await organisationWallet(organisationId, prisma);
  const wallet = await prisma.billingCreditAccount.findUnique({ where: {
    accountId_scopeKey_currency: { accountId: account.id, scopeKey: organisationId, currency: 'USD' } } });
  const [reserved, grants] = await Promise.all([
    wallet ? billingReservedMicrocredits(prisma, wallet.id) : Promise.resolve(0n),
    prisma.billingCreditAdminAdjustment.findMany({
      where: { orgId: organisationId, signedAmountMicrocredits: { gt: 0n } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY_LIMIT + 1, include: grantInclude }),
  ]);
  const balance = wallet?.balanceMicrocredits ?? 0n;
  return {
    organisation: { id: organisation.id, name: organisation.name },
    mode: selection.mode,
    credit_account_id: wallet?.id ?? null,
    balance: { confirmed: amount(balance), reserved: amount(reserved), spendable: amount(balance - reserved) },
    limits: { max_credits: ADMIN_CREDIT_GRANT_MAX_CREDITS.toString(),
      reason_min: ADMIN_CREDIT_GRANT_REASON_MIN, reason_max: ADMIN_CREDIT_GRANT_REASON_MAX },
    grants: grants.slice(0, HISTORY_LIMIT).map(serializeGrant),
    has_more: grants.length > HISTORY_LIMIT,
  };
}

export type AdminCreditGrantInput = {
  organisationId: string;
  credits: string;
  reason: string;
  idempotencyKey: string;
  actor: BillingAdminEffectActor;
};

/**
 * Grants whole credits to the organisation's wallet in its current billing
 * mode, in one serializable transaction with the audit row. A replay of the
 * same key with the same terms returns the original grant; different terms
 * under a used key are refused.
 */
export async function grantOrganisationCredits(input: AdminCreditGrantInput,
  deps?: { prisma?: Db; now?: () => Date }) {
  const micro = adminCreditGrantMicrocredits(input.credits);
  const reason = input.reason.trim();
  if (reason.length < ADMIN_CREDIT_GRANT_REASON_MIN || reason.length > ADMIN_CREDIT_GRANT_REASON_MAX) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_GRANT_REASON_INVALID');
  }
  if (!KEY.test(input.idempotencyKey)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_GRANT_KEY_INVALID');
  }
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = ledgerKey(input.idempotencyKey);
  // Refuse a caller without current authority before any wallet row is created.
  await prisma.$transaction((tx) => lockBillingAdminEffectAuthority(tx, input.actor));
  const { account } = await organisationWallet(input.organisationId, prisma);
  const wallet = await ensureOrganisationCreditAccount(
    { account, organisationId: input.organisationId }, { prisma });
  const adminDomain = getAdminAuthDomain();

  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockBillingAdminEffectAuthority(tx, input.actor);
    const mode = await resolveOrganisationBillingMode(input.organisationId, tx);
    if ((mode.mode === 'live') !== account.livemode) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_ORGANISATION_MODE_CHANGED');
    }
    const balance = await lockCreditBalance(tx, wallet.id);
    const prior = await tx.billingCreditAdminAdjustment.findFirst({
      where: { idempotencyKey: key }, include: grantInclude });
    if (prior) {
      if (prior.orgId !== input.organisationId || prior.creditAccountId !== wallet.id
        || prior.signedAmountMicrocredits !== micro || prior.reason !== reason
        || prior.createdByUserId !== input.actor.userId) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_GRANT_KEY_CONFLICT');
      }
      const current = await tx.billingCreditAccount.findUniqueOrThrow({ where: { id: wallet.id } });
      return { grant: serializeGrant(prior), replayed: true, balance_after: amount(current.balanceMicrocredits) };
    }
    const actor = await tx.user.findUniqueOrThrow({ where: { id: input.actor.userId ?? '' },
      select: { id: true, email: true } });
    if (!actor.email) throw new AppError('FORBIDDEN', 403, 'BILLING_ADMIN_AUTHORITY_REQUIRED');
    // The adjustment coherence trigger compares the creator's superuser role
    // with this transaction-scoped trusted admin domain.
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.admin_auth_domain', ${adminDomain}, true)`);
    const suffix = randomUUID();
    const adjustmentId = `bcag_${suffix}`;
    const entryId = `bceg_${suffix}`;
    const occurredAt = deps?.now?.() ?? new Date();
    const balanceAfter = balance + micro;
    // The adjustment references its entry through a deferred foreign key; the
    // entry trigger requires the adjustment to exist first.
    const created = await tx.billingCreditAdminAdjustment.create({ data: {
      id: adjustmentId, accountId: wallet.accountId, creditAccountId: wallet.id,
      orgId: input.organisationId, teamId: null, signedAmountMicrocredits: micro, reason,
      idempotencyKey: key, createdByUserId: actor.id, createdByEmail: actor.email,
      createdByAdminDomain: adminDomain, creditEntryId: entryId,
    }, include: grantInclude });
    await tx.billingCreditEntry.create({ data: {
      id: entryId, creditAccountId: wallet.id, direction: BillingCreditEntryDirection.CREDIT,
      kind: BillingCreditEntryKind.ADJUSTMENT, amountMicrocredits: micro,
      balanceAfterMicrocredits: balanceAfter, currency: 'USD', idempotencyKey: key,
      sourceType: SOURCE_TYPE, sourceId: adjustmentId, occurredAt,
    } });
    await tx.adminAuditLog.create({ data: {
      actorEmail: actor.email, action: 'billing.credits_granted',
      metadata: { organisation_id: input.organisationId, credit_account_id: wallet.id,
        adjustment_id: adjustmentId, credit_entry_id: entryId, actor_user_id: actor.id,
        amount_microcredits: micro.toString(), credits: input.credits,
        balance_after_microcredits: balanceAfter.toString(),
        livemode: account.livemode, reason },
    } });
    return { grant: serializeGrant(created), replayed: false, balance_after: amount(balanceAfter) };
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

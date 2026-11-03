import { BillingAssignmentScope, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  requireStripeBillingEnabled,
  resolveStripeAccountContext,
  stripeSecretKeyLivemode,
  type StripeAccountContext,
} from './billing-stripe-client.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveOrgBillingResponsibility } from './billing-org-responsibility.service.js';

export type CreditCollectionContext = {
  account: StripeAccountContext;
  stripeCollectionEnabled: boolean;
  stripe?: Pick<
    Stripe,
    'checkout' | 'paymentIntents' | 'paymentMethods' | 'prices' | 'products' | 'rawRequest'
  > | null;
};

const CANONICAL_PORTFOLIO_PRODUCTS = [
  'deeptest',
  'deepsignal',
  'deepwater',
  'docgen',
  'nessie',
] as const;

/**
 * The provider account identity this organisation's credits already live on.
 *
 * `livemode`, when known, is the configured secret key's mode: an account
 * persisted in the other mode is never a candidate, because every caller goes
 * on to settle usage against whatever this returns. With no configured key
 * there is no mode to match and every persisted account is a candidate.
 */
async function resolvePersistedCreditAccount(
  params: { organisationId: string; teamId: string; livemode?: boolean },
  prisma: PrismaClient,
): Promise<StripeAccountContext> {
  const scoped = await prisma.billingCreditAccount.findMany({
    where: {
      orgId: params.organisationId,
      OR: [
        { scope: BillingAssignmentScope.TEAM, teamId: params.teamId },
        { scope: BillingAssignmentScope.ORGANISATION, teamId: null },
      ],
      currency: 'USD',
      ...(params.livemode === undefined ? {} : { account: { livemode: params.livemode } }),
    },
    orderBy: { updatedAt: 'desc' },
    // Deliberately unlimited, and deliberately not `distinct`. The team's own
    // account and the organisation's legitimately coexist while organisation
    // billing responsibility is — or once was — assumed, and a team balance is
    // never swept on assume or release. All this resolves is one provider
    // identity, so what must be unambiguous is the account those rows point at,
    // not how many rows point at it. The OR clause bounds the set to this
    // team's and this organisation's own rows.
    select: { account: { select: { id: true, stripeAccountId: true, livemode: true } } },
  });
  const identities = new Map(scoped.map((row) => [row.account.id, row.account]));
  if (identities.size > 1) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS');
  }
  const [only] = [...identities.values()];
  if (only) return only;

  const persisted = await prisma.billingStripeAccount.findMany({
    ...(params.livemode === undefined ? {} : { where: { livemode: params.livemode } }),
    orderBy: { updatedAt: 'desc' },
    take: 2,
    select: { id: true, stripeAccountId: true, livemode: true },
  });
  if (persisted.length !== 1) {
    throw new AppError(
      'BAD_REQUEST',
      409,
      persisted.length > 1
        ? 'BILLING_CREDIT_ACCOUNT_AMBIGUOUS'
        : 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED',
    );
  }
  const account = persisted[0];
  if (!account) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED');
  }
  return account;
}

export async function resolveCreditCollectionContext(
  params: { organisationId: string; teamId: string },
  deps?: { prisma?: PrismaClient },
): Promise<CreditCollectionContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  if (!getEnv().STRIPE_BILLING_ENABLED) {
    const account = await resolvePersistedCreditAccount(params, prisma);
    return { account, stripeCollectionEnabled: false, stripe: null };
  }
  const configured = requireStripeBillingEnabled();
  const account = await resolveStripeAccountContext(configured.client, configured.livemode, prisma);
  return { account, stripeCollectionEnabled: true, stripe: configured.client };
}

const PROVIDER_UNAVAILABLE = 'BILLING_PAYMENT_PROVIDER_UNAVAILABLE';

/**
 * The refusal a read may answer with, or null when the failure is its own.
 *
 * `mayFallBack` says whether a persisted account could stand in. An unreachable
 * provider leaves the account identity intact, so it can. A secret key whose
 * mode cannot be read cannot: there is no mode to match, so no account is a
 * candidate and the refusal is all there is to return — reported as the
 * provider being unavailable rather than as a configuration code no consumer is
 * ever given. A deployment that configured no key at all keeps its own code;
 * that is a deployment never set up, not a provider gone missing.
 */
function readableProviderRefusal(
  error: unknown,
): { refusal: AppError; mayFallBack: boolean } | null {
  if (!(error instanceof AppError)) return null;
  if (error.message === PROVIDER_UNAVAILABLE) return { refusal: error, mayFallBack: true };
  if (error.message === 'STRIPE_SECRET_KEY_MODE_UNKNOWN') {
    return {
      refusal: new AppError('SERVICE_UNAVAILABLE', 503, PROVIDER_UNAVAILABLE),
      mayFallBack: false,
    };
  }
  return null;
}

/**
 * The collection context a read may use.
 *
 * The Stripe account identity a read needs is already persisted from the first
 * time the provider was reached, so a credential that has expired or a provider
 * that cannot be reached is no reason to refuse to say what the organisation's
 * own credits are. The read then projects the persisted account with collection
 * frozen — the same context a deployment with `STRIPE_BILLING_ENABLED` off
 * produces, so every funding action is already disabled and no payment can be
 * started from it. Writes keep `resolveCreditCollectionContext` and still fail
 * closed with `BILLING_PAYMENT_PROVIDER_UNAVAILABLE`.
 *
 * Only an account in the configured key's own mode will do. Freezing collection
 * does not stop the caller settling usage against whatever this returns, so a
 * test key must never reach a live-mode account or the reverse; where there is
 * no such account, or no mode can be told from the configuration at all, the
 * provider's refusal stands. Every other lookup failure — two distinct
 * identities for one subject, a database error — is permanent and is raised as
 * itself rather than dressed up as a temporary outage.
 */
export async function resolveCreditCollectionContextForRead(
  params: { organisationId: string; teamId: string },
  deps?: {
    prisma?: PrismaClient;
    log?: { error: (details: object, message: string) => void };
    resolveCollection?: typeof resolveCreditCollectionContext;
  },
): Promise<CreditCollectionContext> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  try {
    return await (deps?.resolveCollection ?? resolveCreditCollectionContext)(params, { prisma });
  } catch (caught) {
    const provider = readableProviderRefusal(caught);
    if (!provider) throw caught;
    const refusal = provider.refusal;
    // An operator has to see this: the read keeps working, so nothing else shouts.
    deps?.log?.error(
      { organisationId: params.organisationId, teamId: params.teamId },
      'billing read projected with collection frozen: the payment provider could not be resolved',
    );
    if (!provider.mayFallBack) throw refusal;
    // Only an account in the configured key's own mode will do. Without a mode
    // to match, no persisted account is safe to settle against, so the
    // provider's refusal stands.
    let livemode: boolean;
    try {
      const secretKey = getEnv().STRIPE_SECRET_KEY;
      if (!secretKey) throw refusal;
      livemode = stripeSecretKeyLivemode(secretKey);
    } catch {
      // No key, an unreadable configuration or a key whose mode cannot be told
      // apart: all three leave nothing safe to settle against.
      throw refusal;
    }
    const account = await resolvePersistedCreditAccount({ ...params, livemode }, prisma).catch(
      (lookupFailure: unknown) => {
        // No account in this mode at all — including a deployment that never
        // reached the provider once: its refusal is the accurate cause. Every
        // other lookup failure is permanent and must not be dressed up as a
        // temporary outage.
        if (
          lookupFailure instanceof AppError &&
          lookupFailure.message === 'BILLING_CREDIT_ACCOUNT_NOT_PROVISIONED'
        ) {
          throw refusal;
        }
        throw lookupFailure;
      },
    );
    return { account, stripeCollectionEnabled: false, stripe: null };
  }
}

async function ensureScopedCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string | null;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const scope =
    params.teamId === null ? BillingAssignmentScope.ORGANISATION : BillingAssignmentScope.TEAM;
  const scopeKey =
    params.teamId === null ? params.organisationId : `${params.organisationId}:${params.teamId}`;
  return runBillingSerializableTransaction(
    prisma,
    async (tx) => {
      const customer = await tx.billingStripeCustomer.upsert({
        where: {
          accountId_scopeKey: { accountId: params.account.id, scopeKey },
        },
        create: {
          accountId: params.account.id,
          orgId: params.organisationId,
          teamId: params.teamId,
          scope,
          scopeKey,
        },
        update: {},
      });
      if (
        customer.accountId !== params.account.id ||
        customer.orgId !== params.organisationId ||
        customer.teamId !== params.teamId ||
        customer.scope !== scope ||
        customer.scopeKey !== scopeKey
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_CUSTOMER_SCOPE_CONFLICT');
      }
      const creditAccount = await tx.billingCreditAccount.upsert({
        where: {
          accountId_scopeKey_currency: {
            accountId: params.account.id,
            scopeKey,
            currency: 'USD',
          },
        },
        create: {
          accountId: params.account.id,
          customerId: customer.id,
          orgId: params.organisationId,
          teamId: params.teamId,
          scope,
          scopeKey,
          currency: 'USD',
        },
        update: {},
      });
      if (
        creditAccount.accountId !== params.account.id ||
        creditAccount.customerId !== customer.id ||
        creditAccount.orgId !== params.organisationId ||
        creditAccount.teamId !== params.teamId ||
        creditAccount.scope !== scope ||
        creditAccount.scopeKey !== scopeKey ||
        creditAccount.currency !== 'USD'
      ) {
        throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
      }
      return creditAccount;
    },
    'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED',
  );
}

export async function ensureTeamCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  return ensureScopedCreditAccount(params, deps);
}

export async function ensureOrganisationCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
  },
  deps?: { prisma?: PrismaClient },
) {
  return ensureScopedCreditAccount({ ...params, teamId: null }, deps);
}

/**
 * The single chokepoint every credit debit crosses.
 *
 * With an organisation billing responsibility active, every team's metered
 * spend lands on the ORGANISATION account; without one this is byte-identical
 * to `ensureTeamCreditAccount`. That is the whole of the money side of
 * `Docs/plans/2026-08-15-org-billing-override.md` §2: no caller anywhere in
 * Ledger, the worker, or a product changes.
 */
export async function resolveCreditAccount(
  params: {
    account: StripeAccountContext;
    organisationId: string;
    teamId: string;
  },
  deps?: { prisma?: PrismaClient; resolveResponsibility?: typeof resolveOrgBillingResponsibility },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const responsibility = await (deps?.resolveResponsibility ?? resolveOrgBillingResponsibility)(
    { organisationId: params.organisationId },
    { prisma },
  );
  if (responsibility.active) {
    return ensureOrganisationCreditAccount(
      { account: params.account, organisationId: params.organisationId },
      { prisma },
    );
  }
  return ensureTeamCreditAccount(params, { prisma });
}

export async function resolveCanonicalPortfolioProduct(
  params: {
    creditAccountId: string;
    teamId: string;
    billingMonth: string;
    fallbackProduct: string;
  },
  deps?: { prisma?: PrismaClient },
): Promise<string> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [existing, activeServices] = await Promise.all([
    prisma.billingCreditPortfolioSnapshot.findFirst({
      where: {
        creditAccountId: params.creditAccountId,
        teamId: params.teamId,
        billingMonth: params.billingMonth,
      },
      orderBy: [{ capturedAt: 'desc' }, { ledgerSnapshotCursor: 'desc' }],
      select: { perspectiveProduct: true },
    }),
    prisma.billingService.findMany({
      where: {
        active: true,
        identifier: { in: [...CANONICAL_PORTFOLIO_PRODUCTS] },
      },
      orderBy: { identifier: 'asc' },
      select: { identifier: true },
    }),
  ]);
  return existing?.perspectiveProduct ?? activeServices[0]?.identifier ?? params.fallbackProduct;
}

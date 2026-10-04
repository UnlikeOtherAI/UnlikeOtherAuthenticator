import {
  BillingAssignmentScope,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  MembershipStatus,
  type PrismaClient,
} from '@prisma/client';
import { createHmac } from 'node:crypto';

import { getEnv } from '../config/env.js';
import type {
  BillingCreditAttentionV1,
  BillingCreditFundingRequestActionV1,
  BillingCreditFundingRequestV1,
} from '../contracts/billing-statement-v1.js';
import { BILLING_CREDIT_FUNDING_REQUEST_PATH } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  resolveCreditAccount,
  resolveCreditCollectionContext,
} from './billing-credit-account.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { resolveBillingFundingViewer } from './billing-funding-viewer.service.js';
import { resolveBillingControlledBy } from './billing-org-responsibility.service.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingCreditAttentionCopy } from './billing-credit-attention-copy.catalog.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

/**
 * Return only current billing managers who can act for this exact billing
 * scope. A team owner/admin cannot receive an organisation-funded request
 * unless they also hold an organisation owner/admin role.
 */
export async function resolveBillingFundingRequestRecipients(
  params: {
    organisationId: string;
    teamId: string;
    requesterUserId: string;
    organisationPays: boolean;
  },
  deps?: { prisma?: PrismaClient },
): Promise<string[]> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const memberships = await prisma.teamMember.findMany({
    where: {
      teamId: params.teamId,
      status: MembershipStatus.ACTIVE,
      user: {
        is: {
          lifecycleStatus: 'ACTIVE',
          orgMembers: {
            some: {
              orgId: params.organisationId,
              status: MembershipStatus.ACTIVE,
            },
          },
        },
      },
      team: {
        is: {
          orgId: params.organisationId,
          lifecycleStatus: 'ACTIVE',
          org: { is: { lifecycleStatus: 'ACTIVE' } },
        },
      },
    },
    select: {
      teamRole: true,
      user: {
        select: {
          id: true,
          lifecycleStatus: true,
          orgMembers: {
            where: {
              orgId: params.organisationId,
              status: MembershipStatus.ACTIVE,
            },
            select: { role: true },
          },
        },
      },
    },
  });

  return [...new Set(
    memberships.flatMap(({ teamRole, user }) => {
      if (
        user.lifecycleStatus !== 'ACTIVE' ||
        user.id === params.requesterUserId ||
        user.orgMembers.length !== 1
      ) {
        return [];
      }
      const orgRole = user.orgMembers[0]?.role;
      if (!orgRole) return [];
      const eligible = params.organisationPays
        ? isBillingManager({ scope: BillingAssignmentScope.ORGANISATION, orgRole })
        : isBillingManager({ scope: BillingAssignmentScope.TEAM, orgRole, teamRole });
      return eligible ? [user.id] : [];
    }),
  )].sort();
}

export function billingCreditFundingRequestId(params: {
  accountId: string;
  organisationId: string;
  teamId: string;
  requesterUserId: string;
  now: Date;
  secret?: string;
}): string {
  const day = params.now.toISOString().slice(0, 10);
  const payload = [
    'billing-credit-funding-request:v1',
    params.accountId,
    params.organisationId,
    params.teamId,
    params.requesterUserId,
    day,
  ].join('\0');
  const digest = createHmac('sha256', params.secret ?? getEnv().SHARED_SECRET)
    .update(payload, 'utf8')
    .digest('hex');
  return `bfr1_${digest}`;
}

export type BillingCreditAttentionKind = BillingCreditAttentionV1['kind'];

export async function resolveLatestBillingFundingCreditEntryId(
  params: { creditAccountId: string },
  deps?: { prisma?: PrismaClient },
): Promise<string | null> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const entry = await prisma.billingCreditEntry.findFirst({
    where: {
      creditAccountId: params.creditAccountId,
      direction: BillingCreditEntryDirection.CREDIT,
      kind: {
        in: [
          BillingCreditEntryKind.TOP_UP,
          BillingCreditEntryKind.AUTOMATIC_TOP_UP,
          BillingCreditEntryKind.REFUND_REVERSAL,
          BillingCreditEntryKind.DISPUTE_REVERSAL,
          BillingCreditEntryKind.ADJUSTMENT,
        ],
      },
      amountMicrocredits: { gt: 0n },
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return entry?.id ?? null;
}

export type BillingCreditAttentionInput = {
  creditAccountId: string;
  balanceMicrocredits: bigint;
  periodKey: string;
  meteredBilling: boolean;
  account: {
    autoTopUpGeneration: number;
    autoTopUpState: string;
    autoTopUpThresholdMicrocredits: bigint | null;
    autoTopUpMonthlyChargeCapMinor: bigint | null;
    autoTopUpOptionId: string | null;
  };
  policy: {
    automaticTopUpEnabled: boolean;
    autoTopUpOptions: Array<{
      id: string;
      thresholdMicrocredits: bigint;
      refillOffer: {
        paymentAmountMinor: bigint;
        active: boolean;
        automaticTopUpEligible: boolean;
      };
    }>;
  } | null;
  chargedThisMonthMinor: bigint;
  latestFundingCreditEntryId: string | null;
  paymentMethodExpired: boolean;
  secret?: string;
};

function attentionEventKey(
  kind: BillingCreditAttentionKind,
  input: BillingCreditAttentionInput,
): string {
  const balanceEvent = kind === 'low_credits' || kind === 'credits_exhausted';
  const identity = balanceEvent
    ? (input.latestFundingCreditEntryId ?? 'no-funding-entry')
    : String(input.account.autoTopUpGeneration);
  const digest = createHmac('sha256', input.secret ?? getEnv().SHARED_SECRET)
    .update(
      [
        'billing-credit-attention:v1',
        input.creditAccountId,
        kind,
        input.periodKey,
        identity,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
  return `bca1_${digest}`;
}

/** Build source-authoritative warnings without exposing balances or payment data. */
export function buildBillingCreditAttention(input: BillingCreditAttentionInput) {
  if (!input.meteredBilling) return [];
  const kinds: BillingCreditAttentionKind[] = [];
  if (input.balanceMicrocredits <= 0n) {
    kinds.push('credits_exhausted');
  } else {
    const activeConsentThreshold =
      input.account.autoTopUpState === 'ACTIVE' &&
      input.account.autoTopUpThresholdMicrocredits !== null &&
      input.account.autoTopUpThresholdMicrocredits > 0n
        ? input.account.autoTopUpThresholdMicrocredits
        : null;
    const configuredOptionThreshold = input.policy?.automaticTopUpEnabled
      ? input.policy.autoTopUpOptions
          .filter(
            (option) =>
              option.refillOffer.active &&
              option.refillOffer.automaticTopUpEligible &&
              option.thresholdMicrocredits > 0n,
          )
          .map((option) => option.thresholdMicrocredits)
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0]
      : undefined;
    const threshold = activeConsentThreshold ?? configuredOptionThreshold;
    if (threshold !== undefined && threshold !== null && input.balanceMicrocredits < threshold) {
      kinds.push('low_credits');
    }
  }
  if (
    input.account.autoTopUpState === 'REQUIRES_ACTION' ||
    input.account.autoTopUpState === 'NEEDS_REVIEW'
  ) {
    kinds.push('payment_action_required');
  }
  if (input.paymentMethodExpired) kinds.push('card_expired');
  const remainingCap =
    input.account.autoTopUpMonthlyChargeCapMinor === null
      ? null
      : input.account.autoTopUpMonthlyChargeCapMinor > input.chargedThisMonthMinor
        ? input.account.autoTopUpMonthlyChargeCapMinor - input.chargedThisMonthMinor
        : 0n;
  const selectedOption = input.policy?.autoTopUpOptions.find(
    (option) => option.id === input.account.autoTopUpOptionId,
  );
  const pausedForCap = Boolean(
    input.account.autoTopUpState === 'ACTIVE' &&
      remainingCap !== null &&
      selectedOption &&
      remainingCap < selectedOption.refillOffer.paymentAmountMinor,
  );
  if (input.account.autoTopUpState === 'PAUSED' || pausedForCap) {
    kinds.push('auto_top_up_paused');
  }
  return kinds.map((kind) => ({ event_key: attentionEventKey(kind, input), kind }));
}

export function requireBillingFundingRecipients(recipientUserIds: string[]): void {
  if (recipientUserIds.length === 0) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_FUNDING_RECIPIENT_UNAVAILABLE');
  }
}

export function buildBillingCreditFundingRequestAction(params: {
  body: { product: string; organisation_id: string; team_id: string; user_id: string };
  locale?: BillingCustomerLocale;
}): BillingCreditFundingRequestActionV1 {
  const copy = billingCreditAttentionCopy(params.locale);
  return {
    label: copy.fundingRequestLabel,
    enabled: true,
    disabled_reason: null,
    request: {
      method: 'POST',
      path: BILLING_CREDIT_FUNDING_REQUEST_PATH,
      body: params.body,
    },
  };
}

type FundingRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type FundingRequestDependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  sharedSecret?: string;
  resolveEntitlement?: typeof resolveEffectiveTariffContext;
  resolveViewer?: typeof resolveBillingFundingViewer;
  resolveControlledBy?: typeof resolveBillingControlledBy;
  resolveCollection?: typeof resolveCreditCollectionContext;
  ensureCreditAccount?: typeof resolveCreditAccount;
  resolveRecipients?: typeof resolveBillingFundingRequestRecipients;
};

export async function createBillingCreditFundingRequest(
  params: {
    request: FundingRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: FundingRequestDependencies,
): Promise<BillingCreditFundingRequestV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { payload } = await (deps?.resolveEntitlement ?? resolveEffectiveTariffContext)(
    {
      request: params.request,
      actorToken: params.actorToken,
      credential: params.credential,
      endpoint: params.endpoint,
    },
    { prisma },
  );
  if (!payload.tariff.usage_billing_enabled || !payload.tariff.payment_collection_enabled) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_FUNDING_REQUEST_NOT_AVAILABLE');
  }

  const viewer = await (deps?.resolveViewer ?? resolveBillingFundingViewer)(
    {
      userId: params.request.userId,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const initialControlledBy = await (deps?.resolveControlledBy ?? resolveBillingControlledBy)(
    {
      organisationId: params.request.organisationId,
      userId: params.request.userId,
    },
    { prisma },
  );
  if (initialControlledBy ? initialControlledBy.can_manage : viewer.billingManager) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_FUNDING_REQUEST_NOT_AVAILABLE');
  }
  const collection = await (deps?.resolveCollection ?? resolveCreditCollectionContext)(
    {
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const creditAccount = await (deps?.ensureCreditAccount ?? resolveCreditAccount)(
    {
      account: collection.account,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
    },
    { prisma },
  );
  const controlledBy = await (deps?.resolveControlledBy ?? resolveBillingControlledBy)(
    {
      organisationId: params.request.organisationId,
      userId: params.request.userId,
    },
    { prisma },
  );
  const organisationPays = creditAccount.scope === BillingAssignmentScope.ORGANISATION;
  if (Boolean(controlledBy) !== organisationPays) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_ACCOUNT_SCOPE_CONFLICT');
  }
  const effectiveManager = controlledBy ? controlledBy.can_manage : viewer.billingManager;
  if (effectiveManager) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_FUNDING_REQUEST_NOT_AVAILABLE');
  }
  const recipientUserIds = await (
    deps?.resolveRecipients ?? resolveBillingFundingRequestRecipients
  )(
    {
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      requesterUserId: viewer.userId,
      organisationPays,
    },
    { prisma },
  );
  requireBillingFundingRecipients(recipientUserIds);

  const now = deps?.now?.() ?? new Date();
  const requestId = billingCreditFundingRequestId({
    accountId: creditAccount.id,
    organisationId: params.request.organisationId,
    teamId: params.request.teamId,
    requesterUserId: viewer.userId,
    now,
    secret: deps?.sharedSecret,
  });
  return {
    schema_version: 1 as const,
    request_id: requestId,
    recipient_user_ids: recipientUserIds,
  };
}

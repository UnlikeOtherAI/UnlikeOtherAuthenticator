import {
  BillingAssignmentScope,
  BillingCreditAutoTopUpState,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  authorizeBillingCustomerAction,
  BILLING_CUSTOMER_ACTION,
} from './billing-customer-action-intent.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import {
  isOrganisationBillingManager,
  resolveOrgBillingResponsibility,
} from './billing-org-responsibility.service.js';
import { assertOrgBillingAssumable } from './billing-org-responsibility-guard.service.js';

export type BillingOrgResponsibilityRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type Dependencies = {
  prisma?: PrismaClient;
  now?: () => Date;
  resolveTariff?: typeof resolveEffectiveTariffContext;
  isOrganisationManager?: typeof isOrganisationBillingManager;
  authorizeAction?: typeof authorizeBillingCustomerAction;
  assertAssumable?: typeof assertOrgBillingAssumable;
};

export type BillingOrgResponsibilityView = {
  organisation_id: string;
  active: boolean;
  assumed_at: string | null;
  released_at: string | null;
  deactivated_team_auto_top_ups: number;
};

/**
 * A server-authored evidence identifier for the automatic top-ups this
 * assumption switches off.
 *
 * `billing_credit_auto_top_up_disable_events` is unique on
 * `(app_key_id, actor_jti)`, which is exactly right for a customer clicking
 * "turn off automatic top-up" for one team — and wrong for one assumption that
 * has to switch several teams off at once. The derivation below is namespaced
 * so it cannot be mistaken for, or collide with, a real actor token id, and is
 * deterministic per (assumption, account) so a retried assumption produces the
 * same rows instead of new ones. The event still records the real requesting
 * user and the real app key; only the replay handle is derived.
 */
function assumptionEvidenceJti(responsibilityId: string, creditAccountId: string): string {
  return `org-billing-assume:${responsibilityId}:${creditAccountId}`;
}

async function requireOrganisationBillingManager(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps: Dependencies & { prisma: PrismaClient },
) {
  // The same entitlement path every other billing action uses: it verifies the
  // fresh RS256 actor assertion, its 45-second TTL, the `tv` epoch against the
  // live user row, and active organisation and team membership.
  const { actor } = await (deps.resolveTariff ?? resolveEffectiveTariffContext)(params, {
    prisma: deps.prisma,
  });
  const manager = await (deps.isOrganisationManager ?? isOrganisationBillingManager)(
    { organisationId: params.request.organisationId, userId: params.request.userId },
    { prisma: deps.prisma },
  );
  if (!manager) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_ORG_MANAGER_REQUIRED');
  }
  return actor;
}

function view(params: {
  organisationId: string;
  active: boolean;
  assumedAt: Date | null;
  releasedAt: Date | null;
  deactivatedTeamAutoTopUps: number;
}): BillingOrgResponsibilityView {
  return {
    organisation_id: params.organisationId,
    active: params.active,
    assumed_at: params.assumedAt?.toISOString() ?? null,
    released_at: params.releasedAt?.toISOString() ?? null,
    deactivated_team_auto_top_ups: params.deactivatedTeamAutoTopUps,
  };
}

/**
 * Deactivate — never delete — every team's stored automatic top-up consent.
 *
 * The revision rows stay exactly where they are as commercial history; what is
 * removed is the account's pointer to one, which is what authorises a charge.
 * Releasing the override therefore leaves them inactive and a customer must
 * consent again explicitly: a stored payment consent must never silently
 * resume (Docs/plans/2026-08-15-org-billing-override.md §5).
 */
async function deactivateTeamAutoTopUps(
  tx: Prisma.TransactionClient,
  params: {
    responsibilityId: string;
    organisationId: string;
    credential: VerifiedBillingAppKey;
    userId: string;
  },
): Promise<number> {
  const accounts = await tx.billingCreditAccount.findMany({
    where: {
      orgId: params.organisationId,
      scope: BillingAssignmentScope.TEAM,
      autoTopUpState: { not: BillingCreditAutoTopUpState.DISABLED },
    },
    select: {
      id: true,
      accountId: true,
      teamId: true,
      autoTopUpGeneration: true,
      autoTopUpConsentRevisionId: true,
    },
    orderBy: { id: 'asc' },
  });
  for (const account of accounts) {
    if (!account.autoTopUpConsentRevisionId) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_CONSENT_PREDECESSOR_MISSING');
    }
    await tx.billingCreditAutoTopUpDisableEvent.create({
      data: {
        accountId: account.accountId,
        creditAccountId: account.id,
        orgId: params.organisationId,
        teamId: account.teamId,
        serviceId: params.credential.service.id,
        appKeyId: params.credential.id,
        previousConsentRevisionId: account.autoTopUpConsentRevisionId,
        previousGeneration: account.autoTopUpGeneration,
        actorJti: assumptionEvidenceJti(params.responsibilityId, account.id),
        requestedByUserId: params.userId,
      },
    });
    await tx.billingCreditAccount.update({
      where: { id: account.id },
      data: {
        autoTopUpGeneration: { increment: 1 },
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpPolicyId: null,
        autoTopUpServiceId: null,
        autoTopUpAppKeyId: null,
        autoTopUpConsentRevisionId: null,
        autoTopUpOptionId: null,
        autoTopUpThresholdMicrocredits: null,
        autoTopUpRefillOfferId: null,
        autoTopUpMonthlyChargeCapMinor: null,
        autoTopUpConsentVersion: null,
        autoTopUpConsentedAt: null,
        autoTopUpConsentedByUserId: null,
        stripePaymentMethodId: null,
        paymentMethodSummary: Prisma.DbNull,
      },
    });
    await tx.orgAuditLog.create({
      data: {
        orgId: params.organisationId,
        actorUserId: params.userId,
        action: 'billing.credit_auto_top_up_deactivated_for_org_billing',
        targetType: 'billing_credit_account',
        targetId: account.id,
        metadata: {
          team_id: account.teamId,
          service_id: params.credential.service.id,
          app_key_id: params.credential.id,
          responsibility_id: params.responsibilityId,
          previous_consent_revision_id: account.autoTopUpConsentRevisionId,
        },
      },
    });
  }
  return accounts.length;
}

export async function assumeOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  const actor = await requireOrganisationBillingManager(params, { ...deps, prisma });
  const existing = await resolveOrgBillingResponsibility(
    { organisationId: params.request.organisationId },
    { prisma },
  );
  if (existing.active) {
    return view({
      organisationId: params.request.organisationId,
      active: true,
      assumedAt: existing.assumedAt,
      releasedAt: null,
      deactivatedTeamAutoTopUps: 0,
    });
  }

  return prisma.$transaction(
    async (tx) => {
      await (deps?.assertAssumable ?? assertOrgBillingAssumable)(
        { organisationId: params.request.organisationId, now },
        { prisma: tx },
      );
      await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
        {
          credential: params.credential,
          organisationId: params.request.organisationId,
          teamId: params.request.teamId,
          userId: params.request.userId,
          authorityScope: BillingAssignmentScope.ORGANISATION,
          operation: BILLING_CUSTOMER_ACTION.ORG_BILLING_ASSUME,
          actor,
          request: {
            product: params.request.product,
            organisation_id: params.request.organisationId,
            team_id: params.request.teamId,
            user_id: params.request.userId,
          },
        },
        { prisma: tx },
      );
      const responsibility = await tx.billingOrgResponsibility.upsert({
        where: { orgId: params.request.organisationId },
        create: {
          orgId: params.request.organisationId,
          active: true,
          assumedAt: now,
          assumedByUserId: params.request.userId,
        },
        update: {
          active: true,
          assumedAt: now,
          assumedByUserId: params.request.userId,
          releasedAt: null,
          releasedByUserId: null,
        },
      });
      const deactivated = await deactivateTeamAutoTopUps(tx, {
        responsibilityId: responsibility.id,
        organisationId: params.request.organisationId,
        credential: params.credential,
        userId: params.request.userId,
      });
      await tx.orgAuditLog.create({
        data: {
          orgId: params.request.organisationId,
          actorUserId: params.request.userId,
          action: 'billing.org_responsibility_assumed',
          targetType: 'billing_org_responsibility',
          targetId: responsibility.id,
          metadata: {
            product: params.credential.service.identifier,
            service_id: params.credential.service.id,
            app_key_id: params.credential.id,
            actor_jti: actor.jti,
            deactivated_team_auto_top_ups: deactivated,
          },
        },
      });
      return view({
        organisationId: params.request.organisationId,
        active: true,
        assumedAt: responsibility.assumedAt,
        releasedAt: null,
        deactivatedTeamAutoTopUps: deactivated,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * Releasing reverses the resolver and nothing else. Organisation-scoped ledger
 * rows, invoices and statements stay on the organisation account, where the
 * spend was actually incurred; history is never re-scoped. Team credit
 * balances were never swept, so they are simply reachable again.
 */
export async function releaseOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  const actor = await requireOrganisationBillingManager(params, { ...deps, prisma });

  return prisma.$transaction(
    async (tx) => {
      const current = await tx.billingOrgResponsibility.findUnique({
        where: { orgId: params.request.organisationId },
      });
      if (!current || !current.active) {
        return view({
          organisationId: params.request.organisationId,
          active: false,
          assumedAt: current?.assumedAt ?? null,
          releasedAt: current?.releasedAt ?? null,
          deactivatedTeamAutoTopUps: 0,
        });
      }
      await (deps?.authorizeAction ?? authorizeBillingCustomerAction)(
        {
          credential: params.credential,
          organisationId: params.request.organisationId,
          teamId: params.request.teamId,
          userId: params.request.userId,
          authorityScope: BillingAssignmentScope.ORGANISATION,
          operation: BILLING_CUSTOMER_ACTION.ORG_BILLING_RELEASE,
          actor,
          request: {
            product: params.request.product,
            organisation_id: params.request.organisationId,
            team_id: params.request.teamId,
            user_id: params.request.userId,
          },
        },
        { prisma: tx },
      );
      const released = await tx.billingOrgResponsibility.update({
        where: { id: current.id },
        data: {
          active: false,
          releasedAt: now,
          releasedByUserId: params.request.userId,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          orgId: params.request.organisationId,
          actorUserId: params.request.userId,
          action: 'billing.org_responsibility_released',
          targetType: 'billing_org_responsibility',
          targetId: released.id,
          metadata: {
            product: params.credential.service.identifier,
            service_id: params.credential.service.id,
            app_key_id: params.credential.id,
            actor_jti: actor.jti,
          },
        },
      });
      return view({
        organisationId: params.request.organisationId,
        active: false,
        assumedAt: released.assumedAt,
        releasedAt: released.releasedAt,
        deactivatedTeamAutoTopUps: 0,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function readOrgBillingResponsibility(
  params: {
    request: BillingOrgResponsibilityRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: Dependencies,
): Promise<BillingOrgResponsibilityView & { can_manage: boolean }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  await (deps?.resolveTariff ?? resolveEffectiveTariffContext)(params, { prisma });
  const [state, canManage, record] = await Promise.all([
    resolveOrgBillingResponsibility({ organisationId: params.request.organisationId }, { prisma }),
    (deps?.isOrganisationManager ?? isOrganisationBillingManager)(
      { organisationId: params.request.organisationId, userId: params.request.userId },
      { prisma },
    ),
    prisma.billingOrgResponsibility.findUnique({
      where: { orgId: params.request.organisationId },
      select: { assumedAt: true, releasedAt: true },
    }),
  ]);
  return {
    ...view({
      organisationId: params.request.organisationId,
      active: state.active,
      assumedAt: record?.assumedAt ?? null,
      releasedAt: state.active ? null : (record?.releasedAt ?? null),
      deactivatedTeamAutoTopUps: 0,
    }),
    can_manage: canManage,
  };
}

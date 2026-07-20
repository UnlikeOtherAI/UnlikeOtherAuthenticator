import {
  BillingAssignmentScope,
  BillingCollectionMode,
  BillingTariffMode,
  MembershipStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor, type BillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  billingCollectionModeToPublic,
  billingModeToPublic,
} from './billing-tariff-serialization.service.js';
import { normalizeBillingServiceIdentifier } from './billing-tariff.service.js';
import { confirmDirectBillingServiceAccess } from './billing-service-access.service.js';
import {
  assertEffectiveTariffPayloadBinding,
  signEffectiveTariffSnapshot,
} from './billing-snapshot.service.js';

export const EFFECTIVE_TARIFF_SCHEMA_VERSION = 1 as const;
export const EFFECTIVE_TARIFF_SNAPSHOT_TTL_SECONDS = 5 * 60;

export type EffectiveTariffPayload = {
  schema_version: typeof EFFECTIVE_TARIFF_SCHEMA_VERSION;
  snapshot_id: string;
  product: {
    id: string;
    identifier: string;
  };
  authorized_party: {
    app_key_id: string;
  };
  subject: {
    user_id: string;
    organisation_id: string;
    team_id: string;
  };
  tariff: {
    id: string;
    key: string;
    version: number;
    mode: 'standard' | 'free' | 'at_cost' | 'custom';
    collection_mode: 'stripe' | 'manual' | 'none';
    markup_bps: number;
    markup_percent: string;
    usage_price_multiplier_bps: number;
    monthly_subscription: {
      amount_minor: string;
      currency: string;
    };
    usage_billing_enabled: boolean;
    payment_collection_enabled: boolean;
    raw_usage_preserved: true;
  };
  assignment: {
    scope: 'team' | 'organisation' | 'service_default';
    id: string | null;
  };
  issued_at: string;
  expires_at: string;
};

type EffectiveTariffRequest = {
  product: string;
  organisationId: string;
  teamId: string;
  userId: string;
};

type TariffRow = {
  id: string;
  key: string;
  version: number;
  mode: BillingTariffMode;
  collectionMode: BillingCollectionMode;
  markupBps: number;
  monthlyAmountMinor: bigint;
  currency: string;
};

function client(deps?: { prisma?: PrismaClient }): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function assignmentScope(
  scope: BillingAssignmentScope | null,
): EffectiveTariffPayload['assignment']['scope'] {
  if (scope === BillingAssignmentScope.TEAM) return 'team';
  if (scope === BillingAssignmentScope.ORGANISATION) return 'organisation';
  return 'service_default';
}

function priceMultiplierBps(tariff: TariffRow): number {
  if (tariff.mode === BillingTariffMode.FREE) return 0;
  return 10_000 + tariff.markupBps;
}

function payloadFor(params: {
  request: EffectiveTariffRequest;
  credential: VerifiedBillingAppKey;
  tariff: TariffRow;
  assignment: {
    id: string | null;
    scope: BillingAssignmentScope | null;
  };
  nowEpochSeconds: number;
}): EffectiveTariffPayload {
  const issuedAt = new Date(params.nowEpochSeconds * 1000);
  const expiresAt = new Date(
    (params.nowEpochSeconds + EFFECTIVE_TARIFF_SNAPSHOT_TTL_SECONDS) * 1000,
  );
  return {
    schema_version: EFFECTIVE_TARIFF_SCHEMA_VERSION,
    snapshot_id: randomUUID(),
    product: {
      id: params.credential.service.id,
      identifier: params.credential.service.identifier,
    },
    authorized_party: {
      app_key_id: params.credential.id,
    },
    subject: {
      user_id: params.request.userId,
      organisation_id: params.request.organisationId,
      team_id: params.request.teamId,
    },
    tariff: {
      id: params.tariff.id,
      key: params.tariff.key,
      version: params.tariff.version,
      mode: billingModeToPublic(params.tariff.mode),
      collection_mode: billingCollectionModeToPublic(params.tariff.collectionMode),
      markup_bps: params.tariff.markupBps,
      markup_percent: (params.tariff.markupBps / 100).toFixed(2),
      usage_price_multiplier_bps: priceMultiplierBps(params.tariff),
      monthly_subscription: {
        amount_minor: params.tariff.monthlyAmountMinor.toString(),
        currency: params.tariff.currency,
      },
      usage_billing_enabled: params.tariff.mode !== BillingTariffMode.FREE,
      payment_collection_enabled: params.tariff.collectionMode !== BillingCollectionMode.NONE,
      raw_usage_preserved: true,
    },
    assignment: {
      scope: assignmentScope(params.assignment.scope),
      id: params.assignment.id,
    },
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

export async function resolveEffectiveTariffContext(
  params: {
    request: EffectiveTariffRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => number;
    verifyActor?: typeof verifyBillingActor;
  },
): Promise<{ actor: BillingActor; payload: EffectiveTariffPayload }> {
  const product = normalizeBillingServiceIdentifier(params.request.product);
  if (product !== params.credential.service.identifier) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  const request = { ...params.request, product };
  const actor = await (deps?.verifyActor ?? verifyBillingActor)({
    token: params.actorToken,
    credential: params.credential,
    request,
  });

  const prisma = client(deps);
  const teamScopeKey = `${request.organisationId}:${request.teamId}`;
  const resolution = await prisma.$transaction(
    async (tx) => {
      const [service, user, orgMember, team, teamAssignment, orgAssignment, defaultTariff] =
        await Promise.all([
          tx.billingService.findFirst({
            where: {
              id: params.credential.service.id,
              identifier: product,
              active: true,
            },
            select: { id: true },
          }),
          tx.user.findUnique({
            where: { id: request.userId },
            select: { id: true },
          }),
          tx.orgMember.findUnique({
            where: {
              orgId_userId: {
                orgId: request.organisationId,
                userId: request.userId,
              },
            },
            select: { status: true },
          }),
          tx.team.findFirst({
            where: {
              id: request.teamId,
              orgId: request.organisationId,
              members: {
                some: {
                  userId: request.userId,
                  status: MembershipStatus.ACTIVE,
                },
              },
            },
            select: { id: true },
          }),
          tx.billingTariffAssignment.findFirst({
            where: {
              serviceId: params.credential.service.id,
              orgId: request.organisationId,
              teamId: request.teamId,
              scope: BillingAssignmentScope.TEAM,
              scopeKey: teamScopeKey,
              tariff: { serviceId: params.credential.service.id },
            },
            include: { tariff: true },
          }),
          tx.billingTariffAssignment.findFirst({
            where: {
              serviceId: params.credential.service.id,
              orgId: request.organisationId,
              teamId: null,
              scope: BillingAssignmentScope.ORGANISATION,
              scopeKey: request.organisationId,
              tariff: { serviceId: params.credential.service.id },
            },
            include: { tariff: true },
          }),
          tx.billingTariff.findFirst({
            where: {
              serviceId: params.credential.service.id,
              isDefault: true,
            },
          }),
        ]);
      return {
        service,
        user,
        orgMember,
        team,
        teamAssignment,
        orgAssignment,
        defaultTariff,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  if (
    !resolution.service ||
    !resolution.user ||
    resolution.orgMember?.status !== MembershipStatus.ACTIVE ||
    !resolution.team
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }

  const selected = resolution.teamAssignment ?? resolution.orgAssignment;
  const tariff = selected?.tariff ?? resolution.defaultTariff;
  if (!tariff) {
    throw new AppError('INTERNAL', 500, 'BILLING_DEFAULT_TARIFF_MISSING');
  }

  const now = deps?.now?.() ?? Math.floor(Date.now() / 1000);
  const payload = payloadFor({
    request,
    credential: params.credential,
    tariff,
    assignment: {
      id: selected?.id ?? null,
      scope: selected?.scope ?? null,
    },
    nowEpochSeconds: now,
  });
  assertEffectiveTariffPayloadBinding(payload, {
    productId: params.credential.service.id,
    productIdentifier: product,
    appKeyId: params.credential.id,
    userId: request.userId,
    organisationId: request.organisationId,
    teamId: request.teamId,
  });
  return { actor, payload };
}

export async function getEffectiveTariffSnapshot(
  params: {
    request: EffectiveTariffRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => number;
    verifyActor?: typeof verifyBillingActor;
    signSnapshot?: typeof signEffectiveTariffSnapshot;
    confirmAccess?: typeof confirmDirectBillingServiceAccess;
  },
): Promise<{ snapshot: string; payload: EffectiveTariffPayload }> {
  const { payload } = await resolveEffectiveTariffContext(params, deps);
  await (deps?.confirmAccess ?? confirmDirectBillingServiceAccess)(
    {
      serviceId: params.credential.service.id,
      appKeyId: params.credential.id,
      organisationId: params.request.organisationId,
      teamId: params.request.teamId,
      userId: params.request.userId,
    },
    { prisma: deps?.prisma },
  );
  const issuedAtEpochSeconds = Math.floor(Date.parse(payload.issued_at) / 1000);
  const snapshot = await (deps?.signSnapshot ?? signEffectiveTariffSnapshot)({
    payload,
    audience: params.credential.actorIssuer,
    issuedAtEpochSeconds,
    expiresAtEpochSeconds: issuedAtEpochSeconds + EFFECTIVE_TARIFF_SNAPSHOT_TTL_SECONDS,
  });
  return { snapshot, payload };
}

import {
  BillingCollectionMode,
  BillingTariffSource,
  BillingTariffMode,
  MembershipStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor, type BillingActor } from './billing-actor.service.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  billingCollectionModeToPublic,
  billingModeToPublic,
} from './billing-tariff-serialization.service.js';
import { normalizeBillingServiceIdentifier } from './billing-tariff.service.js';
import { resolveBillingTariffForMonth, utcBillingMonth } from './billing-tariff-history.service.js';
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
    mode: 'standard' | 'free' | 'at_cost' | 'custom';
    collection_mode: 'stripe' | 'manual' | 'none';
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
  scope: BillingTariffSource,
): EffectiveTariffPayload['assignment']['scope'] {
  if (scope === BillingTariffSource.TEAM) return 'team';
  if (scope === BillingTariffSource.ORGANISATION) return 'organisation';
  return 'service_default';
}

export function customerBillingTariff(
  tariff: EffectiveTariffPayload['tariff'],
): Pick<
  EffectiveTariffPayload['tariff'],
  | 'collection_mode'
  | 'monthly_subscription'
  | 'usage_billing_enabled'
  | 'payment_collection_enabled'
  | 'raw_usage_preserved'
> {
  return {
    collection_mode: tariff.collection_mode,
    monthly_subscription: tariff.monthly_subscription,
    usage_billing_enabled: tariff.usage_billing_enabled,
    payment_collection_enabled: tariff.payment_collection_enabled,
    raw_usage_preserved: tariff.raw_usage_preserved,
  };
}

function payloadFor(params: {
  request: EffectiveTariffRequest;
  credential: VerifiedBillingAppKey;
  tariff: TariffRow;
  assignment: {
    id: string | null;
    scope: BillingTariffSource;
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
      mode: billingModeToPublic(params.tariff.mode),
      collection_mode: billingCollectionModeToPublic(params.tariff.collectionMode),
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
    endpoint: BillingActorEndpoint;
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
    endpoint: params.endpoint,
    request,
  });

  const prisma = client(deps);
  const resolution = await prisma.$transaction(
    async (tx) => {
      const [service, user, orgMember, team] =
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
            where: { lifecycleStatus: 'ACTIVE', id: request.userId },
            select: { id: true, tokenVersion: true },
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
              lifecycleStatus: 'ACTIVE',
              org: { lifecycleStatus: 'ACTIVE' },
              members: {
                some: {
                  userId: request.userId,
                  status: MembershipStatus.ACTIVE,
                },
              },
            },
            select: { id: true },
          }),
        ]);
      return {
        service,
        user,
        orgMember,
        team,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  if (
    !resolution.service ||
    !resolution.user ||
    resolution.user.tokenVersion !== actor.tv ||
    resolution.orgMember?.status !== MembershipStatus.ACTIVE ||
    !resolution.team
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  }

  const effective = await resolveBillingTariffForMonth(prisma, {
    serviceId: params.credential.service.id,
    organisationId: request.organisationId,
    teamId: request.teamId,
    billingMonth: utcBillingMonth(new Date((deps?.now?.() ?? Math.floor(Date.now() / 1000)) * 1000)),
  });
  const tariff = effective.tariff;

  const now = deps?.now?.() ?? Math.floor(Date.now() / 1000);
  const payload = payloadFor({
    request,
    credential: params.credential,
    tariff,
    assignment: {
      id: effective.assignmentId,
      scope: effective.source,
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
    endpoint: BillingActorEndpoint;
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => number;
    verifyActor?: typeof verifyBillingActor;
    signSnapshot?: typeof signEffectiveTariffSnapshot;
  },
): Promise<{ snapshot: string; payload: EffectiveTariffPayload }> {
  const { payload } = await resolveEffectiveTariffContext(params, deps);
  const issuedAtEpochSeconds = Math.floor(Date.parse(payload.issued_at) / 1000);
  const snapshot = await (deps?.signSnapshot ?? signEffectiveTariffSnapshot)({
    payload,
    audience: params.credential.actorIssuer,
    issuedAtEpochSeconds,
    expiresAtEpochSeconds: issuedAtEpochSeconds + EFFECTIVE_TARIFF_SNAPSHOT_TTL_SECONDS,
  });
  return { snapshot, payload };
}

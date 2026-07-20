import { BillingAppKeyPurpose, MembershipStatus, Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { normalizeBillingServiceIdentifier } from './billing-tariff.service.js';

type AccessPrisma = Pick<PrismaClient, 'billingServiceAccess'>;

function client(deps?: { prisma?: AccessPrisma }): AccessPrisma {
  return deps?.prisma ?? getAdminPrisma();
}

export async function confirmDirectBillingServiceAccess(
  params: {
    serviceId: string;
    appKeyId: string;
    organisationId: string;
    teamId: string;
    userId: string;
  },
  deps?: { prisma?: AccessPrisma; now?: () => Date },
): Promise<void> {
  const now = deps?.now?.() ?? new Date();
  await client(deps).billingServiceAccess.upsert({
    where: {
      serviceId_teamId_userId: {
        serviceId: params.serviceId,
        teamId: params.teamId,
        userId: params.userId,
      },
    },
    create: {
      serviceId: params.serviceId,
      appKeyId: params.appKeyId,
      orgId: params.organisationId,
      teamId: params.teamId,
      userId: params.userId,
      active: true,
      firstConfirmedAt: now,
      lastConfirmedAt: now,
    },
    update: {
      appKeyId: params.appKeyId,
      orgId: params.organisationId,
      active: true,
      revokedAt: null,
      lastConfirmedAt: now,
    },
  });
}

export async function confirmAuthenticatedDirectBillingServiceAccess(
  params: {
    credential: VerifiedBillingAppKey;
    actorToken: string;
    request: {
      product: string;
      organisationId: string;
      teamId: string;
      userId: string;
    };
  },
  deps?: {
    prisma?: PrismaClient;
    now?: () => Date;
    verifyActor?: typeof verifyBillingActor;
  },
): Promise<void> {
  const product = normalizeBillingServiceIdentifier(params.request.product);
  if (
    params.credential.purpose !== BillingAppKeyPurpose.CUSTOMER_LIFECYCLE ||
    product !== params.credential.service.identifier
  ) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  const request = { ...params.request, product };
  await (deps?.verifyActor ?? verifyBillingActor)({
    token: params.actorToken,
    credential: params.credential,
    request,
  });

  const prisma = deps?.prisma ?? getAdminPrisma();
  const confirmedAt = deps?.now?.() ?? new Date();
  await prisma.$transaction(
    async (tx) => {
      const [service, orgMember, team] = await Promise.all([
        tx.billingService.findFirst({
          where: {
            id: params.credential.service.id,
            identifier: product,
            active: true,
          },
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
      ]);
      if (!service || orgMember?.status !== MembershipStatus.ACTIVE || !team) {
        throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
      }
      await confirmDirectBillingServiceAccess(
        {
          serviceId: params.credential.service.id,
          appKeyId: params.credential.id,
          organisationId: request.organisationId,
          teamId: request.teamId,
          userId: request.userId,
        },
        { prisma: tx, now: () => confirmedAt },
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export type DirectBillingServiceAccess = {
  serviceId: string;
  product: string;
  name: string;
  userIds: string[];
};

export async function listDirectTeamBillingServiceAccess(
  params: { organisationId: string; teamId: string },
  deps?: { prisma?: AccessPrisma },
): Promise<DirectBillingServiceAccess[]> {
  const rows = await client(deps).billingServiceAccess.findMany({
    where: {
      orgId: params.organisationId,
      teamId: params.teamId,
      active: true,
      revokedAt: null,
      user: {
        orgMembers: {
          some: {
            orgId: params.organisationId,
            status: MembershipStatus.ACTIVE,
          },
        },
        teamMembers: {
          some: {
            teamId: params.teamId,
            status: MembershipStatus.ACTIVE,
          },
        },
      },
    },
    select: {
      serviceId: true,
      userId: true,
      service: {
        select: { identifier: true, name: true, active: true },
      },
    },
  });
  const services = new Map<string, DirectBillingServiceAccess>();
  for (const row of rows) {
    if (!row.service.active) continue;
    const existing = services.get(row.serviceId) ?? {
      serviceId: row.serviceId,
      product: row.service.identifier,
      name: row.service.name,
      userIds: [],
    };
    if (!existing.userIds.includes(row.userId)) existing.userIds.push(row.userId);
    services.set(row.serviceId, existing);
  }
  return [...services.values()]
    .map((service) => ({ ...service, userIds: service.userIds.sort() }))
    .sort((left, right) => left.product.localeCompare(right.product));
}

export function billingAccessFingerprint(accesses: DirectBillingServiceAccess[]): string {
  const canonical = accesses
    .map((access) => ({
      serviceId: access.serviceId,
      userIds: [...access.userIds].sort(),
    }))
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

import { Prisma, type PrismaClient } from '@prisma/client';

import { getPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import type { PublicRsaJwk } from './client-jwk.service.js';

type IntegrationRequestPrisma = Pick<PrismaClient, 'clientDomainIntegrationRequest'>;

function prismaClient(deps?: { prisma?: IntegrationRequestPrisma }): IntegrationRequestPrisma {
  return deps?.prisma ?? (getPrisma() as unknown as IntegrationRequestPrisma);
}

export type IntegrationRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED';

export type IntegrationRequestRow = {
  id: string;
  domain: string;
  status: IntegrationRequestStatus;
  contactEmail: string;
  publicJwk: Prisma.JsonValue;
  jwkFingerprint: string;
  kid: string;
  jwksUrl: string;
  configUrl: string | null;
  configSummary: Prisma.JsonValue | null;
  declineReason: string | null;
  submittedAt: Date;
  lastSeenAt: Date;
};

/**
 * Find the single open (non-accepted) row for a domain, if any. The partial unique
 * index on (domain) WHERE status IN ('PENDING','DECLINED') guarantees at most one.
 */
export async function findOpenIntegrationRequest(
  domain: string,
  deps?: { prisma?: IntegrationRequestPrisma },
): Promise<IntegrationRequestRow | null> {
  const normalized = normalizeDomain(domain);
  const row = await prismaClient(deps).clientDomainIntegrationRequest.findFirst({
    where: { domain: normalized, status: { in: ['PENDING', 'DECLINED'] } },
  });
  return (row as IntegrationRequestRow | null) ?? null;
}

export type UpsertPendingParams = {
  domain: string;
  kid: string;
  publicJwk: PublicRsaJwk;
  jwkFingerprint: string;
  jwksUrl: string;
  configUrl: string;
  contactEmail: string;
  configSummary?: Prisma.InputJsonValue;
};

export type UpsertPendingOutcome =
  | { kind: 'created'; row: IntegrationRequestRow }
  | { kind: 'updated'; row: IntegrationRequestRow }
  | { kind: 'unchanged'; row: IntegrationRequestRow };

/**
 * Create or update a PENDING integration request. If a PENDING row already exists for
 * this domain with the same fingerprint, `jwksUrl`, and `contactEmail`, only `lastSeenAt`
 * is bumped and the result is reported as `unchanged`. If the fingerprint or metadata
 * changed, the row is updated in place (the partial unique index allows this).
 */
export async function upsertPendingIntegrationRequest(
  params: UpsertPendingParams,
  deps?: { prisma?: IntegrationRequestPrisma },
): Promise<UpsertPendingOutcome> {
  const normalized = normalizeDomain(params.domain);
  const prisma = prismaClient(deps);

  const existing = (await prisma.clientDomainIntegrationRequest.findFirst({
    where: { domain: normalized, status: 'PENDING' },
  })) as IntegrationRequestRow | null;

  if (existing) {
    const unchanged =
      existing.jwkFingerprint === params.jwkFingerprint &&
      existing.kid === params.kid &&
      existing.jwksUrl === params.jwksUrl &&
      existing.contactEmail === params.contactEmail;

    if (unchanged) {
      const row = (await prisma.clientDomainIntegrationRequest.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      })) as IntegrationRequestRow;
      return { kind: 'unchanged', row };
    }

    const row = (await prisma.clientDomainIntegrationRequest.update({
      where: { id: existing.id },
      data: {
        kid: params.kid,
        publicJwk: params.publicJwk as unknown as Prisma.InputJsonValue,
        jwkFingerprint: params.jwkFingerprint,
        jwksUrl: params.jwksUrl,
        contactEmail: params.contactEmail,
        configUrl: params.configUrl,
        configSummary: params.configSummary ?? Prisma.JsonNull,
        lastSeenAt: new Date(),
      },
    })) as IntegrationRequestRow;
    return { kind: 'updated', row };
  }

  const row = (await prisma.clientDomainIntegrationRequest.create({
    data: {
      domain: normalized,
      status: 'PENDING',
      contactEmail: params.contactEmail,
      publicJwk: params.publicJwk as unknown as Prisma.InputJsonValue,
      jwkFingerprint: params.jwkFingerprint,
      kid: params.kid,
      jwksUrl: params.jwksUrl,
      configUrl: params.configUrl,
      configSummary: params.configSummary,
    },
  })) as IntegrationRequestRow;
  return { kind: 'created', row };
}

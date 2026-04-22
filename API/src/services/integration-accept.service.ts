import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { decryptClaimSecret } from '../utils/claim-secret-crypto.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog, type AuditLogPrisma } from './audit-log.service.js';
import {
  computeJwkFingerprint,
  parsePublicRsaJwk,
  type PublicRsaJwk,
} from './client-jwk.service.js';
import {
  createDomainClientHash,
  digestDomainClientHash,
  generateClientSecret,
} from './domain-secret.service.js';
import {
  createClaimToken,
  type ClaimTokenCreated,
  type IntegrationClaimTokenRow,
} from './integration-claim.service.js';
import type { IntegrationRequestRow } from './integration-request.service.js';

type AcceptPrisma = Pick<
  PrismaClient,
  | 'clientDomain'
  | 'clientDomainJwk'
  | 'clientDomainSecret'
  | 'clientDomainIntegrationRequest'
  | 'integrationClaimToken'
  | 'adminAuditLog'
  | '$transaction'
>;

function prismaClient(deps?: { prisma?: AcceptPrisma }): AcceptPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as AcceptPrisma);
}

function labelFor(domain: string, label?: string): string {
  const trimmed = label?.trim();
  return trimmed || domain;
}

export type AcceptIntegrationParams = {
  id: string;
  reviewerEmail: string;
  label?: string;
  clientSecret?: string;
  ttlMs?: number;
  now?: Date;
};

export type AcceptIntegrationResult = {
  integration: IntegrationRequestRow;
  clientDomainId: string;
  clientHash: string;
  hashPrefix: string;
  rawClientSecret: string;
  claim: ClaimTokenCreated;
};

/**
 * Promote a PENDING integration request to ACCEPTED in a single transaction.
 *
 * The transaction writes five rows:
 *   1. `client_domains` (status active, label defaulting to the partner's domain)
 *   2. `client_domain_jwks` (the public RSA JWK captured during auto-discovery)
 *   3. `client_domain_secrets` (HMAC-digest of the client hash; raw secret never stored)
 *   4. `integration_claim_tokens` (AES-256-GCM wrapped raw secret + expiry)
 *   5. `client_domain_integration_requests` — status ACCEPTED, reviewer stamped
 *
 * Returns the raw secret and raw claim token *in memory only* so the caller can
 * email the claim link. Neither is persisted in plaintext.
 */
export async function acceptIntegrationRequest(
  params: AcceptIntegrationParams,
  deps?: { prisma?: AcceptPrisma; sharedSecret?: string },
): Promise<AcceptIntegrationResult> {
  const prisma = prismaClient(deps);
  const rawClientSecret = params.clientSecret?.trim() || generateClientSecret();
  if (rawClientSecret.length < 32) {
    throw new AppError('BAD_REQUEST', 400, 'CLIENT_SECRET_TOO_SHORT');
  }

  return prisma.$transaction(async (tx) => {
    const existing = (await tx.clientDomainIntegrationRequest.findUnique({
      where: { id: params.id },
    })) as IntegrationRequestRow | null;
    if (!existing) throw new AppError('NOT_FOUND', 404, 'INTEGRATION_REQUEST_NOT_FOUND');
    if (existing.status !== 'PENDING') {
      throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_REQUEST_NOT_PENDING');
    }

    const domain = existing.domain;
    const jwk: PublicRsaJwk = parsePublicRsaJwk(existing.publicJwk);
    const fingerprint = existing.jwkFingerprint || computeJwkFingerprint(jwk);

    const conflict = await tx.clientDomain.findUnique({
      where: { domain },
      select: { id: true },
    });
    if (conflict) throw new AppError('BAD_REQUEST', 400, 'DOMAIN_ALREADY_EXISTS');

    const clientHash = createDomainClientHash(domain, rawClientSecret);
    const hashPrefix = clientHash.slice(0, 12);
    const secretDigest = digestDomainClientHash(clientHash, deps?.sharedSecret);

    const clientDomain = await tx.clientDomain.create({
      data: {
        domain,
        label: labelFor(domain, params.label),
        status: 'active',
        jwks: {
          create: {
            kid: jwk.kid,
            jwk: jwk as unknown as Prisma.InputJsonValue,
            fingerprint,
            active: true,
            createdByEmail: params.reviewerEmail,
          },
        },
        secrets: {
          create: {
            active: true,
            hashPrefix,
            secretDigest,
          },
        },
      },
      select: { id: true },
    });

    const now = params.now ?? new Date();
    const claim = await createClaimToken(
      {
        integrationId: existing.id,
        clientSecret: rawClientSecret,
        ttlMs: params.ttlMs,
        now,
      },
      { prisma: tx as unknown as AcceptPrisma, sharedSecret: deps?.sharedSecret },
    );

    const updated = (await tx.clientDomainIntegrationRequest.update({
      where: { id: existing.id },
      data: {
        status: 'ACCEPTED',
        reviewedAt: now,
        reviewedByEmail: params.reviewerEmail,
        clientDomainId: clientDomain.id,
      },
    })) as IntegrationRequestRow;

    await writeAuditLog(
      {
        actorEmail: params.reviewerEmail,
        action: 'integration.accepted',
        targetDomain: domain,
        metadata: {
          integrationRequestId: updated.id,
          clientDomainId: clientDomain.id,
          hashPrefix,
        },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return {
      integration: updated,
      clientDomainId: clientDomain.id,
      clientHash,
      hashPrefix,
      rawClientSecret,
      claim,
    };
  });
}

export type ResendClaimParams = {
  id: string;
  actorEmail: string;
  ttlMs?: number;
  now?: Date;
};

export type ResendClaimResult = {
  integration: IntegrationRequestRow;
  claim: ClaimTokenCreated;
};

/**
 * Issue a fresh claim token for an already-ACCEPTED integration request by
 * decrypting the existing unused token's secret, deleting it, and creating a new
 * row with the same secret. Throws if the integration has no unused claim token
 * left (partner already claimed — admin must Rotate instead).
 */
export async function resendIntegrationClaim(
  params: ResendClaimParams,
  deps?: { prisma?: AcceptPrisma; sharedSecret?: string },
): Promise<ResendClaimResult> {
  const prisma = prismaClient(deps);

  return prisma.$transaction(async (tx) => {
    const existing = (await tx.clientDomainIntegrationRequest.findUnique({
      where: { id: params.id },
    })) as IntegrationRequestRow | null;
    if (!existing) throw new AppError('NOT_FOUND', 404, 'INTEGRATION_REQUEST_NOT_FOUND');
    if (existing.status !== 'ACCEPTED') {
      throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_REQUEST_NOT_ACCEPTED');
    }

    const token = (await tx.integrationClaimToken.findFirst({
      where: { integrationId: existing.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    })) as IntegrationClaimTokenRow | null;
    if (!token || !token.encryptedSecret || !token.encryptionIv || !token.encryptionTag) {
      throw new AppError('BAD_REQUEST', 400, 'CLAIM_ALREADY_CLAIMED');
    }

    const clientSecret = decryptClaimSecret(
      {
        ciphertext: token.encryptedSecret,
        iv: token.encryptionIv,
        tag: token.encryptionTag,
      },
      { sharedSecret: deps?.sharedSecret },
    );

    await tx.integrationClaimToken.deleteMany({
      where: { integrationId: existing.id, usedAt: null },
    });

    const now = params.now ?? new Date();
    const claim = await createClaimToken(
      {
        integrationId: existing.id,
        clientSecret,
        ttlMs: params.ttlMs,
        now,
      },
      { prisma: tx as unknown as AcceptPrisma, sharedSecret: deps?.sharedSecret },
    );

    await writeAuditLog(
      {
        actorEmail: params.actorEmail,
        action: 'integration.claim_resent',
        targetDomain: existing.domain,
        metadata: { integrationRequestId: existing.id },
      },
      { prisma: tx as unknown as AuditLogPrisma },
    );

    return { integration: existing, claim };
  });
}

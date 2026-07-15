import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { verifyAccessToken, type AccessTokenClaims } from '../../services/access-token.service.js';
import {
  getCurrentSignatureStatus,
  readSignerReceipt,
} from '../../services/signature-access.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

const ReceiptParamsSchema = z.object({ signatureId: z.string().trim().min(1).max(200) }).strict();

function accessToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice('bearer '.length).trim() || null
    : trimmed;
}

async function requireSigner(request: FastifyRequest): Promise<AccessTokenClaims> {
  const token = accessToken(request.headers['x-uoa-access-token']);
  if (!token) throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  return verifyAccessToken(token, { prisma: request.adminDb });
}

function rateKey(prefix: string, request: FastifyRequest): string {
  return `${prefix}:ip:${request.ip || 'unknown'}`;
}

const statusRateLimit = createRateLimiter({
  keyBuilder: (request) => rateKey('signature-me-status', request),
  limit: 120,
  windowMs: 5 * 60 * 1000,
});
const receiptRateLimit = createRateLimiter({
  keyBuilder: (request) => rateKey('signature-me-receipt', request),
  limit: 60,
  windowMs: 60 * 60 * 1000,
});

function statusResponse(status: Awaited<ReturnType<typeof getCurrentSignatureStatus>>) {
  return {
    enabled: status.enabled,
    complete: status.complete,
    policy_revision: status.policyRevision,
    requirements: status.requirements.map((item) => ({
      agreement_id: item.agreementId,
      agreement_version_id: item.agreementVersionId,
      agreement_title: item.agreementTitle,
      title: item.title,
      version: item.version,
      signing_method: item.signingMethod.toLowerCase(),
      source_pdf_sha256: item.sourcePdfSha256,
      satisfied: item.satisfied,
      signature_id: item.signatureId,
      signed_at: item.signedAt?.toISOString() ?? null,
      verification_reference: item.verificationReference,
      receipt_pdf_sha256: item.receiptPdfSha256,
    })),
  };
}

export function registerSignatureMeRoutes(app: FastifyInstance): void {
  app.get('/signatures/me/status', { preHandler: [statusRateLimit] }, async (request, reply) => {
    const claims = await requireSigner(request);
    const status = await getCurrentSignatureStatus(
      { domain: normalizeDomain(claims.domain), userId: claims.userId },
      { prisma: request.adminDb },
    );
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
    return { ok: true, domain: normalizeDomain(claims.domain), ...statusResponse(status) };
  });

  app.get(
    '/signatures/me/receipts/:signatureId',
    { preHandler: [receiptRateLimit] },
    async (request, reply) => {
      const claims = await requireSigner(request);
      const { signatureId } = ReceiptParamsSchema.parse(request.params);
      const receipt = await readSignerReceipt(
        {
          domain: normalizeDomain(claims.domain),
          userId: claims.userId,
          signatureId,
        },
        { prisma: request.adminDb },
      );
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Cache-Control', 'private, no-store')
        .header('Pragma', 'no-cache')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${receipt.filename}"`)
        .header('ETag', `"sha256-${receipt.sha256}"`)
        .send(receipt.value);
    },
  );
}

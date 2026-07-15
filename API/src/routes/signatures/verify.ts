import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { verifyPublicSignatureReference } from '../../services/signature-access.service.js';

const ParamsSchema = z
  .object({ reference: z.string().regex(/^[A-Za-z0-9_-]{24,64}$/u) })
  .strict();

const verifyRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) =>
    `signature-public-verify:ip:${request.ip || 'unknown'}`,
  limit: 60,
  windowMs: 60 * 60 * 1000,
});

export function registerSignatureVerificationRoute(app: FastifyInstance): void {
  app.get(
    '/signatures/verify/:reference',
    { preHandler: [verifyRateLimit] },
    async (request, reply) => {
      const { reference } = ParamsSchema.parse(request.params);
      const result = await verifyPublicSignatureReference(reference, {
        prisma: request.adminDb,
      });
      reply.header('Cache-Control', 'public, max-age=60');
      return {
        ok: true,
        state: result.state,
        integrity_verified: result.integrityVerified,
        verification_reference: result.verificationReference,
        agreement_id: result.agreementId,
        agreement_version_id: result.agreementVersionId,
        agreement_version: result.agreementVersion,
        source_pdf_sha256: result.sourcePdfSha256,
        receipt_pdf_sha256: result.receiptPdfSha256,
        signed_at: result.signedAt.toISOString(),
        evidence_kid: result.evidenceKeyId,
        revoked_at: result.revokedAt?.toISOString() ?? null,
      };
    },
  );
}

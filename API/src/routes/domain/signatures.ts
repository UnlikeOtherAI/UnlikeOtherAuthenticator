import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { getCurrentSignatureStatus } from '../../services/signature-access.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

const QuerySchema = z.object({ config_url: z.string().trim().min(1).max(2048) }).strict();
const BodySchema = z.object({ user_id: z.string().trim().min(1).max(200) }).strict();

const statusRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) =>
    `domain-signature-status:${request.domainAuthClientId ?? request.ip ?? 'unknown'}`,
  limit: 300,
  windowMs: 5 * 60 * 1000,
});

export function registerDomainSignatureRoutes(app: FastifyInstance): void {
  app.post(
    '/domain/signatures/status',
    { preHandler: [configVerifier, requireDomainHashAuth, statusRateLimit] },
    async (request, reply) => {
      QuerySchema.parse(request.query);
      const { user_id: userId } = BodySchema.parse(request.body);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const domain = normalizeDomain(config.domain);
      const domainRole = await request.adminDb.domainRole.findUnique({
        where: { domain_userId: { domain, userId } },
        select: { userId: true },
      });
      if (!domainRole) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');
      const status = await getCurrentSignatureStatus(
        { domain, userId },
        { prisma: request.adminDb },
      );
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
      return {
        ok: true,
        user_id: userId,
        domain,
        enabled: status.enabled,
        complete: status.complete,
        policy_revision: status.policyRevision,
        requirements: status.requirements.map((item) => ({
          agreement_id: item.agreementId,
          agreement_version_id: item.agreementVersionId,
          agreement_title: item.agreementTitle,
          version: item.version,
          satisfied: item.satisfied,
          signature_id: item.signatureId,
          signed_at: item.signedAt?.toISOString() ?? null,
          verification_reference: item.verificationReference,
          source_pdf_sha256: item.sourcePdfSha256,
          receipt_pdf_sha256: item.receiptPdfSha256,
        })),
      };
    },
  );
}

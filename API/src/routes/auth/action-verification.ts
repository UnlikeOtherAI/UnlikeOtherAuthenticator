import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { startActionVerification, verifyActionVerification } from '../../services/action-verification.service.js';
import { AppError } from '../../utils/errors.js';

const Binding = z.object({ actionDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const Start = Binding.extend({ description: z.string().trim().min(1).max(240) }).strict();
const Verify = Binding.extend({
  challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();
const limit = createRateLimiter({
  limit: 120, windowMs: 60_000,
  keyBuilder: (request) => `action-verification:${request.domainAuthClientDomainId}`,
});

export function registerActionVerificationRoutes(app: FastifyInstance): void {
  for (const action of ['start', 'verify'] as const) {
    app.post(`/auth/action-verification/${action}`, {
      preHandler: [configVerifier, requireDomainHashAuth, limit],
    }, async (request, reply) => {
      const claims = await resolveOrgUserClaims(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl || claims.domain !== config.domain) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }
      const context = { claims, config, configUrl };
      const result = action === 'start'
        ? await startActionVerification({ ...context, ...Start.parse(request.body) }, { prisma: request.adminDb })
        : await verifyActionVerification({ ...context, ...Verify.parse(request.body) }, { prisma: request.adminDb });
      reply.header('Cache-Control', 'no-store').send(result);
    });
  }
}

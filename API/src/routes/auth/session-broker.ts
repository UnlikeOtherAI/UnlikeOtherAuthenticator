import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { validateSessionBroker } from '../../services/session-broker.service.js';
import { AppError } from '../../utils/errors.js';
import { tokenExchangePreAuthRateLimiter } from './rate-limit-keys.js';
const body = z.object({ token: z.string().min(1).max(16 * 1024) }).strict();
const limit = createRateLimiter({ limit: 600, windowMs: 60_000,
  keyBuilder: (request) => `session-broker:${request.domainAuthClientDomainId}` });
export function registerSessionBrokerRoutes(app: FastifyInstance): void {
  app.post('/auth/session-broker/validate', {
    bodyLimit: 20 * 1024,
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache'); },
    preHandler: [tokenExchangePreAuthRateLimiter, configVerifier, requireDomainHashAuth, limit],
  }, async (request) => {
    if (!request.config || !request.domainAuthClientDomainId) throw new AppError('UNAUTHORIZED', 401);
    return validateSessionBroker({ token: body.parse(request.body).token, targetDomain: request.config.domain },
      { prisma: request.adminDb });
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAccessStatusEnabled } from '../../middleware/access-status-enabled.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { startLifecycleStatus, verifyLifecycleStatus } from '../../services/lifecycle-status.service.js';
import { AppError } from '../../utils/errors.js';

function context(request: FastifyRequest) {
  if (!request.config || !request.configUrl) throw new AppError('INTERNAL', 500);
  return { config: request.config, configUrl: request.configUrl };
}
export function registerLifecycleStatusRoutes(app: FastifyInstance) {
  const options = { onRequest: requireAccessStatusEnabled, preHandler: [configVerifier, createRateLimiter({ limit: 10, windowMs: 15 * 60_000, keyBuilder: r => `lifecycle:${r.ip}` })] };
  app.post('/auth/lifecycle-status/start', options, async request => {
    const body = z.object({ email: z.string().email().max(320) }).strict().parse(request.body);
    return startLifecycleStatus({ ...context(request), ...body });
  });
  app.post('/auth/lifecycle-status/verify', options, async request => {
    const body = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), twoFactorCode: z.string().regex(/^\d{6}$/).optional() }).strict().parse(request.body);
    return verifyLifecycleStatus({ ...context(request), ...body });
  });
}

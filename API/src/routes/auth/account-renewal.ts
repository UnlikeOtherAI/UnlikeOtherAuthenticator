import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requestAccountRenewal } from '../../services/account-renewal.service.js';
import { startLifecycleStatus, verifyLifecycleStatus } from '../../services/lifecycle-status.service.js';
import { AppError } from '../../utils/errors.js';

const limit = createRateLimiter({ keyBuilder: request => `account-renewal:${request.ip}`, limit: 10, windowMs: 60 * 60 * 1000 });

export function registerAccountRenewalRoute(app: FastifyInstance): void {
  app.post('/auth/account-renewal/start', { preHandler: [limit, configVerifier] }, async request => {
    const { email } = z.object({ email: z.email() }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('INTERNAL', 500);
    return startLifecycleStatus({ email, config: request.config, configUrl: request.configUrl });
  });
  app.post('/auth/account-renewal/request', { preHandler: [limit, configVerifier] }, async request => {
    const body = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/),
      twoFactorCode: z.string().regex(/^\d{6}$/).optional() }).strict().parse(request.body);
    if (!request.config || !request.configUrl) throw new AppError('INTERNAL', 500);
    const verified = await verifyLifecycleStatus({ ...body, config: request.config, configUrl: request.configUrl });
    return requestAccountRenewal(verified.user.id);
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requestAccountRenewal } from '../../services/account-renewal.service.js';

const limit = createRateLimiter({ keyBuilder: request => `account-renewal:${request.ip}`, limit: 10, windowMs: 60 * 60 * 1000 });

export function registerAccountRenewalRoute(app: FastifyInstance): void {
  app.post('/auth/account-renewal/request', { preHandler: [limit, configVerifier] }, async request => {
    const { email } = z.object({ email: z.email() }).strict().parse(request.body);
    if (!request.config) return { ok: true };
    return requestAccountRenewal(email.trim().toLowerCase(), request.config);
  });
}

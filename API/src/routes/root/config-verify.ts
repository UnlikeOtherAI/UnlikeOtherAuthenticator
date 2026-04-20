import type { FastifyInstance } from 'fastify';

import { getEnv } from '../../config/env.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  parseVerifyConfigRequest,
  verifyClientConfig,
} from '../../services/config-debug.service.js';
import { AppError } from '../../utils/errors.js';

const configVerifyRateLimiter = createRateLimiter({
  limit: 10,
  windowMs: 60 * 1000,
  keyBuilder: (request) => `config-verify:${request.ip || 'unknown'}`,
});

async function requireDebugConfigVerifyEnabled(): Promise<void> {
  const env = getEnv();
  if (!env.DEBUG_ENABLED || env.NODE_ENV === 'production') {
    throw new AppError('NOT_FOUND', 404);
  }
}

export function registerConfigVerifyRoute(app: FastifyInstance): void {
  app.post(
    '/config/verify',
    { preHandler: [requireDebugConfigVerifyEnabled, configVerifyRateLimiter] },
    async (request) => {
      const body = parseVerifyConfigRequest(request.body);
      return await verifyClientConfig(body);
    },
  );
}

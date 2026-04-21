import type { FastifyInstance } from 'fastify';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  parseValidateConfigRequest,
  verifyClientConfig,
} from '../../services/config-debug.service.js';

const configValidateRateLimiter = createRateLimiter({
  limit: 20,
  windowMs: 60 * 1000,
  keyBuilder: (request) => `config-validate:${request.ip || 'unknown'}`,
});

export function registerConfigValidateRoute(app: FastifyInstance): void {
  app.post(
    '/config/validate',
    { preHandler: [configValidateRateLimiter] },
    async (request) => {
      const body = parseValidateConfigRequest(request.body);
      return await verifyClientConfig(body);
    },
  );
}

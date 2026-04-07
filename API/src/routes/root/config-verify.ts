import type { FastifyInstance } from 'fastify';

import {
  parseVerifyConfigRequest,
  verifyClientConfig,
} from '../../services/config-debug.service.js';

export function registerConfigVerifyRoute(app: FastifyInstance): void {
  app.post('/config/verify', async (request) => {
    const body = parseVerifyConfigRequest(request.body);
    return await verifyClientConfig(body);
  });
}

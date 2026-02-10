import type { FastifyInstance } from 'fastify';

import { registerTwoFactorVerifyRoute } from './verify.js';

export function registerTwoFactorRoutes(app: FastifyInstance): void {
  registerTwoFactorVerifyRoute(app);
}


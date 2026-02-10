import type { FastifyInstance } from 'fastify';

import { registerTwoFactorResetRoutes } from './reset.js';
import { registerTwoFactorVerifyRoute } from './verify.js';

export function registerTwoFactorRoutes(app: FastifyInstance): void {
  registerTwoFactorResetRoutes(app);
  registerTwoFactorVerifyRoute(app);
}

import type { FastifyInstance } from 'fastify';

import { registerTwoFactorResetRoutes } from './reset.js';
import { registerTwoFactorSelfServiceRoutes } from './self-service.js';
import { registerTwoFactorVerifyRoute } from './verify.js';

export function registerTwoFactorRoutes(app: FastifyInstance): void {
  registerTwoFactorResetRoutes(app);
  registerTwoFactorSelfServiceRoutes(app);
  registerTwoFactorVerifyRoute(app);
}

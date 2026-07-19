import type { FastifyInstance } from 'fastify';

import { registerEffectiveTariffRoute } from './effective-tariff.js';
import { registerBillingJwksRoute } from './jwks.js';

export function registerBillingRoutes(app: FastifyInstance): void {
  registerBillingJwksRoute(app);
  registerEffectiveTariffRoute(app);
}

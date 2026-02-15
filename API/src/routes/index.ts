import type { FastifyInstance } from 'fastify';

import { PUBLIC_ERROR_MESSAGE } from '../config/constants.js';
import { registerAuthRoutes } from './auth/index.js';
import { registerDomainRoutes } from './domain/index.js';
import { registerInternalOrgRoutes } from './internal/org/index.js';
import { registerHealthRoutes } from './health/index.js';
import { registerI18nRoutes } from './i18n/index.js';
import { registerOrgRoutes } from './org/index.js';
import { registerTwoFactorRoutes } from './twofactor/index.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerDomainRoutes(app);
  registerInternalOrgRoutes(app);
  registerOrgRoutes(app);
  registerI18nRoutes(app);
  registerTwoFactorRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    // Keep 404s generic as well; avoid leaking route existence via message copy.
    reply.status(404).send({ error: PUBLIC_ERROR_MESSAGE });
  });
}

import type { FastifyInstance } from 'fastify';

import { registerAuthRoutes } from './auth/index.js';
import { registerHealthRoutes } from './health/index.js';
import { registerI18nRoutes } from './i18n/index.js';
import { registerTwoFactorRoutes } from './twofactor/index.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerI18nRoutes(app);
  registerTwoFactorRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    reply.status(404).send({ error: 'Not found' });
  });
}

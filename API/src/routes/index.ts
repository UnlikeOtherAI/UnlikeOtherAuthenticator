import type { FastifyInstance } from 'fastify';

import { registerAuthRoutes } from './auth/index.js';
import { registerHealthRoutes } from './health/index.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerHealthRoutes(app);
  registerAuthRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    reply.status(404).send({ error: 'Not found' });
  });
}

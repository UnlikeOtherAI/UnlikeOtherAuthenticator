import fastify, { type FastifyInstance } from 'fastify';

import { getEnv } from './config/env.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRoutes } from './routes/index.js';

export async function createApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  registerErrorHandler(app);
  await registerRoutes(app);

  return app;
}

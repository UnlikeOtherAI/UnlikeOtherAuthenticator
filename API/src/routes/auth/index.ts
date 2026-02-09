import type { FastifyInstance } from 'fastify';

import { registerAuthEntrypointRoute } from './entrypoint.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
}


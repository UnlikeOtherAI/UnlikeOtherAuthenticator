import type { FastifyInstance } from 'fastify';

import { registerAuthEntrypointRoute } from './entrypoint.js';
import { registerAuthRegisterRoute } from './register.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
  registerAuthRegisterRoute(app);
}

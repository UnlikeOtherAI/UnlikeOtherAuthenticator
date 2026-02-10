import type { FastifyInstance } from 'fastify';

import { registerI18nGetRoute } from './get.js';

export function registerI18nRoutes(app: FastifyInstance): void {
  registerI18nGetRoute(app);
}


import type { FastifyInstance } from 'fastify';

import { registerEmailSendRoute } from './send.js';

export function registerEmailRoutes(app: FastifyInstance): void {
  registerEmailSendRoute(app);
}

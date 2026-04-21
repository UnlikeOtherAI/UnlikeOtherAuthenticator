import type { FastifyInstance } from 'fastify';

import { readAdminConfigJwt } from '../../../services/admin-auth-config.service.js';

const adminConfigResponseSchema = {
  type: 'string',
} as const;

export function registerInternalAdminConfigRoute(app: FastifyInstance): void {
  app.get(
    '/internal/admin/config',
    { schema: { response: { 200: adminConfigResponseSchema } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.type('text/plain; charset=utf-8').status(200).send(readAdminConfigJwt());
    },
  );
}

import type { FastifyInstance } from 'fastify';

import { readPublicConfigJwks } from '../services/config-jwks.service.js';

const configJwksResponseSchema = {
  type: 'object',
  required: ['keys'],
  properties: {
    keys: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;

export function registerConfigJwksRoute(app: FastifyInstance): void {
  app.get(
    '/.well-known/jwks.json',
    { schema: { response: { 200: configJwksResponseSchema } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=300');
      reply.type('application/json; charset=utf-8').send(readPublicConfigJwks());
    },
  );
}

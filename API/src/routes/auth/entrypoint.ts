import type { FastifyInstance } from 'fastify';

import { configVerifier } from '../../middleware/config-verifier.js';

export function registerAuthEntrypointRoute(app: FastifyInstance): void {
  // OAuth popup entrypoint. This must start by fetching the config JWT from a URL supplied by the client.
  app.get(
    '/auth',
    {
      preHandler: [configVerifier],
    },
    async (_request, reply) => {
      // UI rendering comes later; this endpoint currently asserts the config fetch happens first.
      reply.status(200).send({ ok: true });
    },
  );
}


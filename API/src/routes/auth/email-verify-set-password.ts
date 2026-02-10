import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validateVerifyEmailToken } from '../../services/auth-verify-email.service.js';

const QuerySchema = z
  .object({
    token: z.string().min(1),
  })
  .passthrough();

export function registerAuthEmailVerifySetPasswordRoute(app: FastifyInstance): void {
  // Email link landing endpoint. UI rendering comes later; for now, we validate the token
  // so "clicking the link" has a stable server-side behavior.
  app.get(
    '/auth/email/verify-set-password',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      await validateVerifyEmailToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      reply.status(200).send({ ok: true });
    },
  );
}


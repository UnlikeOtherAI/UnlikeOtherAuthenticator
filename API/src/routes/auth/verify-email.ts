import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { verifyEmailAndSetPassword } from '../../services/auth-verify-email.service.js';

const BodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes the "verify email + set password" flow for new users.
  app.post(
    '/auth/verify-email',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token, password } = BodySchema.parse(request.body);

      if (!request.config || !request.configUrl) {
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      await verifyEmailAndSetPassword({
        token,
        password,
        config: request.config,
        configUrl: request.configUrl,
      });

      reply.status(200).send({ ok: true });
    },
  );
}


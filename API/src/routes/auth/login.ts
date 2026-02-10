import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';

const LoginBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  })
  .strict();

export function registerAuthLoginRoute(app: FastifyInstance): void {
  app.post(
    '/auth/login',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { email, password } = LoginBodySchema.parse(request.body);

      // configVerifier guarantees request.config is set on success.
      const config = request.config;
      if (!config) {
        // Defensive: should never happen; still keep the error generic via global handler.
        throw new Error('missing request.config');
      }

      await loginWithEmailPassword({ email, password, config });

      reply.status(200).send({ ok: true });
    },
  );
}


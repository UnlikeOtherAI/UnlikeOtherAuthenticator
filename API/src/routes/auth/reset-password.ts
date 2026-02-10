import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requestPasswordReset, resetPasswordWithToken } from '../../services/auth-reset-password.service.js';

const SUCCESS_MESSAGE = 'We sent instructions to your email';

const RequestBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

const ResetBodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export function registerAuthResetPasswordRoutes(app: FastifyInstance): void {
  // Initiates the password reset flow. Never reveals whether the email exists.
  app.post(
    '/auth/reset-password/request',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const parsed = RequestBodySchema.safeParse(request.body);
      const email = parsed.success ? parsed.data.email : null;

      if (email && request.config && request.configUrl) {
        try {
          await requestPasswordReset({
            email,
            config: request.config,
            configUrl: request.configUrl,
          });
        } catch (err) {
          request.log.error({ err }, 'password reset request failed');
        }
      }

      reply.status(200).send({ message: SUCCESS_MESSAGE });
    },
  );

  // Completes the password reset flow by consuming the token and setting a new password.
  app.post(
    '/auth/reset-password',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token, password } = ResetBodySchema.parse(request.body);

      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      await resetPasswordWithToken({
        token,
        password,
        config: request.config,
        configUrl: request.configUrl,
      });

      reply.status(200).send({ ok: true });
    },
  );
}


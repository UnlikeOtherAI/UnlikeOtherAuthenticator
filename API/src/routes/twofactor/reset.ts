import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requestTwoFaReset, resetTwoFaWithToken } from '../../services/twofactor-reset.service.js';

const SUCCESS_MESSAGE = 'We sent instructions to your email';

const RequestBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

const ResetBodySchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export function registerTwoFactorResetRoutes(app: FastifyInstance): void {
  // Initiates the 2FA reset flow. Never reveals whether the email exists or has 2FA enabled.
  app.post(
    '/2fa/reset/request',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const parsed = RequestBodySchema.safeParse(request.body);
      const email = parsed.success ? parsed.data.email : null;

      if (email && request.config && request.configUrl) {
        try {
          await requestTwoFaReset({
            email,
            config: request.config,
            configUrl: request.configUrl,
          });
        } catch (err) {
          request.log.error({ err }, '2FA reset request failed');
        }
      }

      reply.status(200).send({ message: SUCCESS_MESSAGE });
    },
  );

  // Completes the 2FA reset by consuming the token and disabling 2FA on the user record.
  app.post(
    '/2fa/reset',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token } = ResetBodySchema.parse(request.body);

      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      await resetTwoFaWithToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      reply.status(200).send({ ok: true });
    },
  );
}


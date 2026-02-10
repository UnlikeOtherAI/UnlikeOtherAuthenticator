import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requestRegistrationInstructions } from '../../services/auth-register.service.js';

const SUCCESS_MESSAGE = 'We sent instructions to your email';

const RegisterBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

export function registerAuthRegisterRoute(app: FastifyInstance): void {
  app.post(
    '/auth/register',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      // Brief 11: no email enumeration. Always return the same success message regardless
      // of whether the email exists, is new, or is malformed.
      const parsed = RegisterBodySchema.safeParse(request.body);
      const email = parsed.success ? parsed.data.email : null;

      if (email && request.config && request.configUrl) {
        try {
          await requestRegistrationInstructions({
            email,
            config: request.config,
            configUrl: request.configUrl,
          });
        } catch (err) {
          // Never leak internal failures; always return the generic success response.
          request.log.error({ err }, 'registration instructions failed');
        }
      }

      reply.status(200).send({ message: SUCCESS_MESSAGE });
    },
  );
}

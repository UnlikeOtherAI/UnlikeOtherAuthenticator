import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { resetTwoFaWithToken } from '../../services/twofactor-reset.service.js';

const QuerySchema = z
  .object({
    token: z.string().min(1),
  })
  .passthrough();

export function registerAuthEmailTwoFaResetRoute(app: FastifyInstance): void {
  // Email link landing endpoint. For 2FA reset, clicking the link is the verification step;
  // consuming the token disables 2FA so the user can re-enroll.
  app.get(
    '/auth/email/twofa-reset',
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

      await resetTwoFaWithToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      reply.status(200).send({ ok: true });
    },
  );
}


import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validateRegistrationEmailLandingToken } from '../../services/auth-registration-email-link.service.js';

const QuerySchema = z
  .object({
    token: z.string().min(1),
  })
  .passthrough();

export function registerAuthEmailRegistrationLinkRoute(app: FastifyInstance): void {
  // Neutral registration email landing endpoint (existing-user login link vs new-user
  // verify+set-password). Branches server-side by token type to avoid leaking account
  // state in the URL path.
  app.get(
    '/auth/email/link',
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

      const type = await validateRegistrationEmailLandingToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      switch (type) {
        case 'LOGIN_LINK':
          reply.status(200).send({ ok: true });
          return;
        case 'VERIFY_EMAIL_SET_PASSWORD':
          reply.status(200).send({ ok: true });
          return;
        default: {
          // Should be unreachable due to service validation.
          reply.status(400).send({ error: 'Request failed' });
        }
      }
    },
  );
}


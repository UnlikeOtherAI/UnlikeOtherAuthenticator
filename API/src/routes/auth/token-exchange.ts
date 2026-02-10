import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { exchangeAuthorizationCodeForAccessToken } from '../../services/token.service.js';

const BodySchema = z
  .object({
    code: z.string().min(1),
  })
  .strict();

export function registerAuthTokenExchangeRoute(app: FastifyInstance): void {
  // OAuth authorization code exchange. Called by the client backend.
  app.post(
    '/auth/token',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { code } = BodySchema.parse(request.body);

      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      const { accessToken } = await exchangeAuthorizationCodeForAccessToken({
        code,
        config: request.config,
        configUrl: request.configUrl,
      });

      // Keep response OAuth-ish without being overly strict about fields.
      reply.status(200).send({
        access_token: accessToken,
        token_type: 'Bearer',
      });
    },
  );
}


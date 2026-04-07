import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { revokeRefreshTokenFamily } from '../../services/refresh-token.service.js';
import { createClientId } from '../../utils/hash.js';
import { requireEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

const BodySchema = z
  .object({
    refresh_token: z.string().min(1),
  })
  .strict();

export function registerAuthRevokeRoute(app: FastifyInstance): void {
  app.post(
    '/auth/revoke',
    {
      preHandler: [configVerifier, requireDomainHashAuth],
    },
    async (request, reply) => {
      const { refresh_token } = BodySchema.parse(request.body);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

      await revokeRefreshTokenFamily({
        refreshToken: refresh_token,
        domain: request.config.domain,
        configUrl: request.configUrl,
        clientId: createClientId(request.config.domain, SHARED_SECRET),
      });

      reply.status(200).send({ ok: true });
    },
  );
}

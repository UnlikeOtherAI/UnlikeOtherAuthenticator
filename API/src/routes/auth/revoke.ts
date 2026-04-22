import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { revokeRefreshTokenFamily } from '../../services/refresh-token.service.js';
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

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const clientId = request.domainAuthClientId;
      if (!clientId) {
        throw new AppError('UNAUTHORIZED', 401);
      }

      setTenantContextFromRequest(request);
      await request.withTenantTx(async (tx) => {
        await revokeRefreshTokenFamily(
          {
            refreshToken: refresh_token,
            domain: config.domain,
            configUrl,
            clientId,
          },
          { prisma: asPrismaClient(tx) },
        );
      });

      reply.status(200).send({ ok: true });
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { getResolvedAppFeatureFlags } from '../../services/feature-flag-resolution.service.js';

const ParamsSchema = z
  .object({
    appId: z.string().trim().min(1),
  })
  .strict();

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    teamId: z.string().trim().min(1).optional(),
  })
  .strict();

export function registerAppFlagRoutes(app: FastifyInstance): void {
  app.get(
    '/apps/:appId/flags',
    {
      preHandler: [requireDomainHashAuthForDomainQuery],
    },
    async (request, reply) => {
      const { appId } = ParamsSchema.parse(request.params);
      const { domain, userId, teamId } = QuerySchema.parse(request.query);
      const flags = await getResolvedAppFeatureFlags(
        {
          appId,
          domain,
          userId,
          teamId,
        },
        { prisma: request.adminDb },
      );

      reply.header('Cache-Control', 'private, no-store');
      return reply.status(200).send(flags);
    },
  );
}

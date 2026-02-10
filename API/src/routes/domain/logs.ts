import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { listLoginLogsForDomain } from '../../services/login-log.service.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    limit: z.coerce.number().int().positive().optional(),
  })
  .passthrough();

export function registerDomainLogsRoute(app: FastifyInstance): void {
  app.get(
    '/domain/logs',
    {
      preHandler: [requireDomainHashAuthForDomainQuery],
    },
    async (request, reply) => {
      const { domain, limit } = QuerySchema.parse(request.query);

      const logs = await listLoginLogsForDomain({ domain, limit });

      reply.status(200).send({
        ok: true,
        logs: logs.map((l) => ({
          id: l.id,
          user_id: l.userId,
          email: l.email,
          domain: l.domain,
          timestamp: l.createdAt.toISOString(),
          auth_method: l.authMethod,
          ip: l.ip,
          user_agent: l.userAgent,
        })),
      });
    },
  );
}


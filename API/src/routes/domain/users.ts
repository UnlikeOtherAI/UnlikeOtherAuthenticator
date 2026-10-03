import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { listUsersForDomain } from '../../services/domain-users.service.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    user_id: z.string().trim().min(1).max(256).optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();

export function registerDomainUsersRoute(app: FastifyInstance): void {
  app.get(
    '/domain/users',
    {
      preHandler: [requireDomainHashAuthForDomainQuery],
    },
    async (request, reply) => {
      const { domain, limit, user_id } = QuerySchema.parse(request.query);

      const users = await listUsersForDomain({ domain, limit, userId: user_id });

      reply.status(200).send({
        ok: true,
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          avatar_url: u.avatarUrl,
          avatar_source: u.avatarSource,
          avatar_image_url: u.avatarImageUrl,
          twofa_enabled: u.twoFaEnabled,
          role: u.role,
          created_at: u.createdAt.toISOString(),
        })),
      });
    },
  );
}

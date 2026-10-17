import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { enterpriseRevocationFeed } from '../../services/org-sso-revocation.service.js';

export function registerRevocationFeedRoute(app: FastifyInstance): void {
  app.get('/domain/revocations', { preHandler: requireDomainHashAuthForDomainQuery }, async (request, reply) => {
    const query = z.object({ domain: z.string().min(1), cursor: z.string().max(2000).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(request.query);
    return reply.header('Cache-Control', 'no-store').send(await enterpriseRevocationFeed(query.domain, query.cursor, query.limit));
  });
}

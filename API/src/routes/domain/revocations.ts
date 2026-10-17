import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { enterpriseRevocationFeed, enterpriseRevocationCheckpoint } from '../../services/org-sso-revocation.service.js';
import { acknowledgeRevocationConsumer } from '../../services/org-sso-delivery.service.js';

export function registerRevocationFeedRoute(app: FastifyInstance): void {
  app.post('/domain/revocations/checkpoint', { preHandler: requireDomainHashAuthForDomainQuery }, async (request, reply) => {
    const { domain } = z.object({ domain: z.string().min(1) }).strict().parse(request.query);
    z.object({}).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await enterpriseRevocationCheckpoint(domain));
  });
  app.post('/domain/revocation-consumers/ready', { preHandler: requireDomainHashAuthForDomainQuery }, async (request, reply) => {
    const { domain } = z.object({ domain: z.string().min(1) }).strict().parse(request.query);
    const body = z.object({ key_id: z.string().min(1).max(100), challenge: z.string().min(32).max(100),
      proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await acknowledgeRevocationConsumer(domain, body));
  });
  app.get('/domain/revocations', { preHandler: requireDomainHashAuthForDomainQuery }, async (request, reply) => {
    const query = z.object({ domain: z.string().min(1), cursor: z.string().max(2000).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(request.query);
    return reply.header('Cache-Control', 'no-store').send(await enterpriseRevocationFeed(query.domain, query.cursor, query.limit));
  });
}

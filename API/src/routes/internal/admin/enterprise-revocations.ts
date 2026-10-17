import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { registerRevocationConsumer } from '../../../services/org-sso-delivery.service.js';
import { getAdminPrisma } from '../../../db/prisma.js';

export function registerAdminEnterpriseRevocationRoutes(app: FastifyInstance): void {
  const path = '/internal/admin/enterprise/revocation-consumers';
  app.get(path, { preHandler: requireAdminSuperuser }, async (_request, reply) => {
    const rows = await getAdminPrisma().orgRevocationConsumer.findMany({ select: { clientDomain: true,
      destination: true, keyId: true, enabled: true, acknowledgedAt: true, failureCount: true } });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, data: rows });
  });
  app.post(path, { preHandler: requireAdminSuperuser }, async (request, reply) => {
    const body = z.object({ client_domain: z.string().trim().min(1).max(256), destination: z.string().url().max(2000),
      key_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict().parse(request.body);
    const result = await registerRevocationConsumer(body);
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}

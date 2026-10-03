import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { historicalIdentity } from '../../services/entity-lifecycle.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

export function registerHistoricalUserRoutes(app: FastifyInstance) {
  app.get('/domain/historical-users/:id', { preHandler: [requireDomainHashAuthForDomainQuery] }, async request => {
    const { id } = z.object({ id: z.string().min(1).max(256) }).parse(request.params);
    const { domain } = z.object({ domain: z.string().min(1) }).parse(request.query);
    const reference = await getAdminPrisma().historicalIdentityReference.findUnique({
      where: { userId_domain: { userId: id, domain: normalizeDomain(domain) } },
      include: { user: { select: { id: true, name: true, lifecycleStatus: true } } },
    });
    if (!reference || reference.user.lifecycleStatus !== 'DELETED') throw new AppError('NOT_FOUND', 404);
    return historicalIdentity(reference.user);
  });
}

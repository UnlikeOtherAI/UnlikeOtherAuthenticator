import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { readTeamArchive } from '../../services/team-archive.service.js';
import { reconcileTeamArchives } from '../../services/team-archive-reconciliation.service.js';
import { AppError } from '../../utils/errors.js';

export function registerTeamArchiveReceipts(app: FastifyInstance) {
  app.get('/domain/team-archives/:id', { preHandler: [requireDomainHashAuthForDomainQuery] }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!request.domainAuthClientDomainId) throw new AppError('UNAUTHORIZED', 401);
    const receipt = await readTeamArchive(id, request.domainAuthClientDomainId);
    if (!receipt.billing_stopped) await reconcileTeamArchives({ operationId: id });
    return reply.header('Cache-Control', 'no-store').send(await readTeamArchive(id, request.domainAuthClientDomainId));
  });
}

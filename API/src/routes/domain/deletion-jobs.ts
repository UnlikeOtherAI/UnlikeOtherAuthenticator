import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { acknowledgeProductDeletion, productDeletionJobs } from '../../services/entity-deletion-job.service.js';
import { AppError } from '../../utils/errors.js';

export function registerProductDeletionJobs(app: FastifyInstance) {
  const options = { preHandler: [requireDomainHashAuthForDomainQuery] };
  app.get('/domain/deletion-jobs', options, async request => {
    if (!request.domainAuthClientDomainId) throw new AppError('UNAUTHORIZED', 401);
    return { data: await productDeletionJobs(request.domainAuthClientDomainId) };
  });
  app.post('/domain/deletion-jobs/:id/acknowledge', options, async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), outcome: z.enum(['PURGED', 'RETAINED_EVIDENCE']),
      retainedEvidence: z.array(z.object({ label: z.string().trim().min(1).max(120), count: z.number().int().positive().max(1_000_000_000), reason: z.string().trim().min(1).max(500) }).strict()).max(30).optional(),
    }).strict().refine(value => value.outcome === 'RETAINED_EVIDENCE' || !value.retainedEvidence?.length).parse(request.body);
    if (!request.domainAuthClientDomainId || !request.domainAuthClientId) throw new AppError('UNAUTHORIZED', 401);
    const { domain } = z.object({ domain: z.string().min(1) }).parse(request.query);
    return acknowledgeProductDeletion({ clientDomainId: request.domainAuthClientDomainId, jobId: id, authority: { domain, token: request.domainAuthClientId }, ...body });
  });
}

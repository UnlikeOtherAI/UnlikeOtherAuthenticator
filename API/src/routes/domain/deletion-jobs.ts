import { normalizeDomain } from '../../utils/domain.js';
import { getAdminPrisma } from '../../db/prisma.js';
import { acknowledgeProductErasure } from '../../services/product-erasure.service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { acknowledgeProductDeletion, productDeletionJobs } from '../../services/entity-deletion-job.service.js';
import { AppError } from '../../utils/errors.js';

export function registerProductDeletionJobs(app: FastifyInstance) {
  const options = { preHandler: [requireDomainHashAuthForDomainQuery] };
  app.get('/domain/product-participation', options, async (request, reply) => {
    const { domain, subject } = z.object({ domain: z.string(), subject: z.string().min(1).max(256) }).parse(request.query);
    const db = getAdminPrisma();
    const policy = await db.productErasurePolicy.findFirst({ where: { domains: { has: normalizeDomain(domain) } }, select: { id: true } });
    if (!policy) throw new AppError('NOT_FOUND', 404);
    const job = await db.productErasureJob.findFirst({ where: { policyId: policy.id, OR: [{ subject }, { rejoinedSubject: subject }] },
      orderBy: { createdAt: 'desc' }, select: { id: true, rejoinedAt: true } });
    return reply.header('Cache-Control', 'no-store').send({ product: policy.id, active: !job || Boolean(job.rejoinedAt), generation: job?.id ?? 'initial' });
  });
  app.get('/domain/product-erasure-jobs', options, async request => {
    if (!request.domainAuthClientDomainId) throw new AppError('UNAUTHORIZED', 401);
    const { after } = z.object({ after: z.string().uuid().optional() }).parse(request.query);
    const rows = await getAdminPrisma().productErasureReceipt.findMany({ where: { domainId: request.domainAuthClientDomainId,
      acknowledgedAt: null, ...(after && { jobId: { gt: after } }) }, select: { job: { select: { id: true, revision: true, subject: true, policyId: true, impact: true } } },
      orderBy: { jobId: 'asc' }, take: 101 });
    return { data: rows.slice(0, 100).map(row => row.job), next: rows.length > 100 ? rows[99].job.id : null };
  });
  app.post('/domain/product-erasure-jobs/:id/acknowledge', options, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { domain } = z.object({ domain: z.string() }).parse(request.query);
    const body = z.object({ outcome: z.enum(['PURGED','RETAINED_EVIDENCE']), revision: z.number().int().positive() }).strict().parse(request.body);
    if (!request.domainAuthClientId) throw new AppError('UNAUTHORIZED', 401);
    return acknowledgeProductErasure({ ...body, id, domain, token: request.domainAuthClientId });
  });
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

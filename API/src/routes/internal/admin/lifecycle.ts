import { reviewContainer } from '../../../services/product-erasure-containers.service.js';
import { ProductPolicyInput, saveProductErasurePolicy } from '../../../services/product-erasure-policy.service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../../../db/prisma.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { getEntityLifecycle, saveLifecycleTemplate, setEntityLifecycle } from '../../../services/internal-admin-lifecycle.service.js';
import { beginEntityDeletion, executeEntityDeletion, getDeletionJob, getDeletionPreview } from '../../../services/entity-deletion-job.service.js';
import { AppError } from '../../../utils/errors.js';

const Scope = z.enum(['USER', 'ORGANISATION', 'TEAM']);
const Target = z.object({ scope: Scope, id: z.string().min(1) });
const Mode = z.enum(['RETAIN_REFERENCE', 'ERASE_REFERENCE']);
const options = { preHandler: [requireAdminSuperuser] };
function actor(request: FastifyRequest) {
  const claims = request.adminAccessTokenClaims;
  if (!claims) throw new AppError('INTERNAL', 500);
  return { userId: claims.userId, tokenVersion: claims.tokenVersion };
}

export function registerInternalAdminLifecycle(app: FastifyInstance) {
  app.get('/internal/admin/product-erasure', options, async request => {
    const { after } = z.object({ after: z.string().uuid().optional() }).parse(request.query);
    const db = getAdminPrisma();
    const rows = await db.productErasureJob.findMany({ where: { completedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 101, ...(after && { cursor: { id: after }, skip: 1 }),
      select: { id: true, policyId: true, createdAt: true, containerJobId: true, requestedContainer: true,
        receipts: { select: { domainId: true, acknowledgedAt: true } } } });
    return { policies: await db.productErasurePolicy.findMany({ orderBy: { id: 'asc' } }),
      pending: rows.slice(0, 100), next: rows.length > 100 ? rows[99].id : null };
  });
  app.post('/internal/admin/product-erasure/:id/container', options, request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { decision } = z.object({ decision: z.enum(['approve','preserve']) }).strict().parse(request.body);
    return reviewContainer(id, decision, actor(request));
  });
  app.post('/internal/admin/product-erasure', options, request => saveProductErasurePolicy(ProductPolicyInput.parse(request.body), actor(request)));
  app.get('/internal/admin/lifecycle/templates', options, async () => ({ data: await getAdminPrisma().lifecycleReasonTemplate.findMany({ orderBy: [{ scope: 'asc' }, { title: 'asc' }] }) }));
  app.post('/internal/admin/lifecycle/templates', options, async request => {
    const body = z.object({ id: z.string().optional(), scope: Scope, title: z.string().trim().min(1).max(120),
      message: z.string().trim().min(1).max(2000), enabled: z.boolean() }).strict().parse(request.body);
    return saveLifecycleTemplate({ ...body, actor: actor(request) });
  });
  app.get('/internal/admin/lifecycle/:scope/:id', options, async request => {
    const { scope, id } = Target.parse(request.params);
    return getEntityLifecycle(scope, id);
  });
  app.post('/internal/admin/lifecycle/:scope/:id', options, async request => {
    const { scope, id } = Target.parse(request.params);
    const body = z.object({ status: z.enum(['ACTIVE', 'DISABLED']), templateId: z.string().optional(),
      templateRevision: z.number().int().positive().optional(), internalNote: z.string().trim().max(2000).optional() }).strict().parse(request.body);
    return setEntityLifecycle({ scope, id, ...body, actor: actor(request) });
  });
  app.post('/internal/admin/lifecycle/:scope/:id/deletion-preview', options, async request => {
    const { scope, id } = Target.parse(request.params);
    const body = z.object({ mode: Mode }).strict().parse(request.body);
    return getDeletionPreview(scope, id, body.mode);
  });
  app.post('/internal/admin/lifecycle/:scope/:id/delete', options, async request => {
    const { scope, id } = Target.parse(request.params);
    const body = z.object({ mode: Mode, previewDigest: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string(), requestKey: z.string().uuid() }).strict().parse(request.body);
    return beginEntityDeletion({ scope, id, ...body, actor: actor(request) });
  });
  app.get('/internal/admin/lifecycle/deletion-jobs/:id', options, async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return getDeletionJob(id);
  });
  app.post('/internal/admin/lifecycle/deletion-jobs/:id/retry', options, async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return executeEntityDeletion(id, actor(request));
  });
}

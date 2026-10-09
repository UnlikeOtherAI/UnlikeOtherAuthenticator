import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { AppError } from '../../../utils/errors.js';
import { listSmsRecoveryResources, readSmsRecoveryResource } from '../../../services/billing-sms-recovery-admin.service.js';
import { listSmsRecoveryLiabilities } from '../../../services/billing-sms-liability-admin.service.js';
import { SmsRefundRecoverySchema, verifySmsNumberRefund } from '../../../services/billing-sms-refund-recovery.service.js';
import {
  acceptSmsFxPolicy, acceptSmsRoutePolicy, listSmsPolicies, previewSmsFxPolicy,
  previewSmsRoutePolicy, serializeSmsFxPolicy, serializeSmsRoutePolicy,
  SmsRoutePolicyImportSchema, type SmsPolicyActor,
} from '../../../services/billing-sms-policy-admin.service.js';

const FxPreview = z.object({ xml: z.string().min(1).max(100_000).optional() }).strict();
const Acceptance = z.object({ preview_token: z.string().min(1).max(100_000),
  acceptance_reason: z.string().trim().min(8).max(500),
  policy_understood: z.literal(true),
}).strict();
const RouteAcceptance = Acceptance.extend({
  complete_segment_bound: z.literal(true), complete_message_bound: z.literal(true),
}).strict();
function actor(request: FastifyRequest): SmsPolicyActor {
  const claims = request.adminAccessTokenClaims;
  if (!claims) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  return { userId: claims.userId, tokenVersion: claims.tokenVersion,
    email: claims.email, domain: claims.domain };
}
const base = '/internal/admin/billing/sms-policies';
export function registerInternalAdminSmsPolicyRoutes(app: FastifyInstance) {
  const guard = { preHandler: [requireAdminSuperuser] };
  app.post(`${base}/recovery/:resourceId/verify-refund`, guard, async (request, reply) => {
    const { resourceId } = z.object({ resourceId: z.string().min(1).max(160) }).strict().parse(request.params);
    const value = SmsRefundRecoverySchema.parse(request.body);
    return reply.header('Cache-Control', 'private, no-store').send(await verifySmsNumberRefund(resourceId, value, actor(request)));
  });
  app.get(`${base}/liabilities`, guard, async (request, reply) => {
    const value = z.object({ kind: z.enum(['inbound', 'outbound']),
      cursor: z.string().min(1).max(160).optional() }).strict().parse(request.query);
    return reply.header('Cache-Control', 'private, no-store').send(await listSmsRecoveryLiabilities(value.kind, value.cursor));
  });
  app.get(`${base}/recovery`, guard, async (request, reply) => {
    const { cursor } = z.object({ cursor: z.string().min(1).max(160).optional() }).strict().parse(request.query);
    return reply.header('Cache-Control', 'private, no-store').send(await listSmsRecoveryResources(cursor));
  });
  app.get(`${base}/recovery/:resourceId`, guard, async (request, reply) => {
    const { resourceId } = z.object({ resourceId: z.string().min(1).max(160) }).strict().parse(request.params);
    return reply.header('Cache-Control', 'private, no-store').send(await readSmsRecoveryResource(resourceId));
  });
  app.get(base, guard, async (_request, reply) => {
    return reply.header('Cache-Control', 'private, no-store').send(await listSmsPolicies());
  });
  app.post(`${base}/fx/preview`, guard, async (request, reply) => {
    const { xml } = FxPreview.parse(request.body);
    return reply.header('Cache-Control', 'private, no-store').send(await previewSmsFxPolicy(actor(request), xml));
  });
  app.post(`${base}/fx/accept`, guard, async (request, reply) => {
    const value = Acceptance.parse(request.body);
    const result = await acceptSmsFxPolicy(actor(request), value.preview_token, value.acceptance_reason);
    return reply.header('Cache-Control', 'private, no-store').send(serializeSmsFxPolicy(result));
  });
  app.post(`${base}/routes/preview`, guard, async (request, reply) => {
    const value = SmsRoutePolicyImportSchema.parse(request.body);
    return reply.header('Cache-Control', 'private, no-store').send(await previewSmsRoutePolicy(actor(request), value));
  });
  app.post(`${base}/routes/accept`, guard, async (request, reply) => {
    const value = RouteAcceptance.parse(request.body);
    const result = await acceptSmsRoutePolicy(actor(request), value.preview_token, value.acceptance_reason);
    return reply.header('Cache-Control', 'private, no-store').send(serializeSmsRoutePolicy(result));
  });
}

import type { FastifyInstance } from 'fastify';

import { requireBillingLifecycleAppKey } from '../../middleware/billing-app-auth.js';
import {
  DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT,
  getDeepTestNessieInferenceAccess,
} from '../../services/deeptest-nessie-inference-access.service.js';
import { AppError } from '../../utils/errors.js';
import { BillingSubjectRequestSchema, readBillingActorHeader } from '../billing/billing-request.js';

export function registerDeepTestNessieInferenceAccessRoute(app: FastifyInstance): void {
  app.post(DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT, {
    preHandler: [requireBillingLifecycleAppKey],
    schema: { response: { 200: { type: 'object', additionalProperties: false,
      required: ['allowed'], properties: { allowed: { type: 'boolean' } } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = BillingSubjectRequestSchema.parse(request.body);
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    return getDeepTestNessieInferenceAccess({
      credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
      request: { product: body.product, organisationId: body.organisation_id,
        teamId: body.team_id, userId: body.user_id },
    });
  });
}

import { decodeJwt } from 'jose';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  ADMIN_CREDIT_GRANT_REASON_MAX, ADMIN_CREDIT_GRANT_REASON_MIN,
  grantOrganisationCredits, readOrganisationCreditGrants,
} from '../../../services/billing-credit-admin-grant.service.js';
import { AppError } from '../../../utils/errors.js';

const path = '/internal/admin/billing/organisations/:orgId/credit-grants';
const Params = z.object({ orgId: z.string().min(1).max(256) }).strict();
const Grant = z.object({
  credits: z.string().regex(/^[1-9]\d{0,7}$/),
  reason: z.string().trim().min(ADMIN_CREDIT_GRANT_REASON_MIN).max(ADMIN_CREDIT_GRANT_REASON_MAX),
  idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function registerInternalAdminBillingCreditGrantRoutes(app: FastifyInstance): void {
  app.get(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { orgId } = Params.parse(request.params);
    return reply.header('Cache-Control', 'private, no-store')
      .send(await readOrganisationCreditGrants(orgId));
  });

  app.post(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { orgId } = Params.parse(request.params);
    const body = Grant.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    const authorization = request.headers.authorization;
    if (!claims || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    }
    // The pre-handler verified signature, expiry, token version and SUPERUSER.
    // Granting money also needs a session issued in the last five minutes.
    const issued = decodeJwt(authorization.slice(7)).iat;
    const now = Math.floor(Date.now() / 1000);
    if (!issued || issued < now - 300 || issued > now + 30) {
      throw new AppError('UNAUTHORIZED', 401, 'BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED');
    }
    const result = await grantOrganisationCredits({
      organisationId: orgId, credits: body.credits, reason: body.reason,
      idempotencyKey: body.idempotency_key,
      actor: { userId: claims.userId, tokenVersion: claims.tokenVersion,
        email: claims.email, domain: claims.domain },
    });
    return reply.code(result.replayed ? 200 : 201).header('Cache-Control', 'private, no-store').send(result);
  });
}

import { decodeJwt } from 'jose';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAdminAuthDomain, getEnv } from '../../../config/env.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  listPaidUsageExceptions, writeOffPaidUsageException,
} from '../../../services/billing-paid-usage-exception.service.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const Params = z.object({ dispatchId: z.string().min(1).max(160) }).strict();
const WriteOff = z.object({
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(12).max(500),
}).strict();

export function registerInternalAdminPaidUsageExceptionRoutes(app: FastifyInstance) {
  app.get('/internal/admin/billing/paid-usage-exceptions', {
    preHandler: [requireAdminSuperuser],
  }, async (_request, reply) => reply.header('Cache-Control', 'private, no-store')
    .send(await listPaidUsageExceptions()));

  app.post('/internal/admin/billing/paid-usage-exceptions/:dispatchId/write-off', {
    preHandler: [requireAdminSuperuser],
  }, async (request, reply) => {
    const { dispatchId } = Params.parse(request.params);
    const body = WriteOff.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    const authorization = request.headers.authorization;
    if (!claims || typeof authorization !== 'string'
      || !authorization.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    }
    // Signature, expiry, live token version and SUPERUSER role were verified
    // by the pre-handler. Require this sensitive decision to use a recently
    // issued session as well; decoding adds no new authority.
    const issued = decodeJwt(authorization.slice(7)).iat;
    const now = Math.floor(Date.now() / 1000);
    if (!issued || issued < now - 300 || issued > now + 30) {
      throw new AppError('UNAUTHORIZED', 401, 'PAID_EXCEPTION_FRESH_SESSION_REQUIRED');
    }
    const result = await writeOffPaidUsageException({
      dispatchId, evidenceDigest: body.evidence_digest,
      idempotencyKey: body.idempotency_key, reason: body.reason,
      actorUserId: claims.userId, actorTokenVersion: claims.tokenVersion,
      adminDomain: normalizeDomain(getAdminAuthDomain(getEnv())),
    });
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
}

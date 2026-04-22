import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { writeAuditLog } from '../../../services/audit-log.service.js';
import {
  declineIntegrationRequest,
  deleteIntegrationRequest,
  getIntegrationRequestById,
  listIntegrationRequests,
  type IntegrationRequestRow,
  type IntegrationRequestStatus,
} from '../../../services/integration-request.service.js';
import { AppError } from '../../../utils/errors.js';

const ListQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

const IdParamsSchema = z.object({ id: z.string().trim().min(1) });

const DeclineBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = { type: 'array', items: objectSchema } as const;
const nullableObjectSchema = { anyOf: [objectSchema, { type: 'null' }] } as const;
const emptySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
} as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function toAdminRow(row: IntegrationRequestRow) {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    contact_email: row.contactEmail,
    kid: row.kid,
    jwk_fingerprint: row.jwkFingerprint,
    jwks_url: row.jwksUrl,
    config_url: row.configUrl,
    decline_reason: row.declineReason,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    reviewed_by_email: row.reviewedByEmail,
    client_domain_id: row.clientDomainId,
    submitted_at: row.submittedAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}

function toAdminDetail(row: IntegrationRequestRow) {
  return {
    ...toAdminRow(row),
    public_jwk: row.publicJwk,
    config_summary: row.configSummary,
    pre_validation_result: row.preValidationResult,
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminIntegrationRequestRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/integration-requests',
    adminRoute(arraySchema),
    async (request) => {
      const { status, limit } = ListQuerySchema.parse(request.query ?? {});
      const rows = await listIntegrationRequests({
        status: status as IntegrationRequestStatus | undefined,
        limit,
      });
      return rows.map(toAdminRow);
    },
  );

  app.get(
    '/internal/admin/integration-requests/:id',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const row = await getIntegrationRequestById(id);
      return row ? toAdminDetail(row) : null;
    },
  );

  app.post(
    '/internal/admin/integration-requests/:id/decline',
    adminRoute(objectSchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const { reason } = DeclineBodySchema.parse(request.body ?? {});
      const reviewerEmail = requireActorEmail(request);
      const row = await declineIntegrationRequest({ id, reason, reviewerEmail });
      await writeAuditLog({
        actorEmail: reviewerEmail,
        action: 'integration.declined',
        targetDomain: row.domain,
        metadata: { integrationRequestId: row.id, reason },
      });
      return toAdminDetail(row);
    },
  );

  app.delete(
    '/internal/admin/integration-requests/:id',
    adminRoute(emptySchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);
      const row = await deleteIntegrationRequest(id);
      await writeAuditLog({
        actorEmail,
        action: 'integration.deleted',
        targetDomain: row.domain,
        metadata: { integrationRequestId: row.id, priorStatus: row.status },
      });
      return { ok: true };
    },
  );
}

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../../config/env.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { sendIntegrationApprovedEmail } from '../../../services/email.service.js';
import {
  acceptIntegrationRequest,
  resendIntegrationClaim,
} from '../../../services/integration-accept.service.js';
import {
  declineIntegrationRequest,
  deleteIntegrationRequest,
  getIntegrationRequestById,
  listIntegrationRequests,
  type IntegrationRequestRow,
  type IntegrationRequestStatus,
} from '../../../services/integration-request.service.js';
import { getAppLogger } from '../../../utils/app-logger.js';
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

const DeliveryModeSchema = z.enum(['email', 'reveal']);

const AcceptBodySchema = z
  .object({
    label: z.string().trim().min(1).max(255).optional(),
    clientSecret: z.string().trim().min(32).max(512).optional(),
    deliveryMode: DeliveryModeSchema.optional(),
  })
  .strict()
  .optional();

const ResendBodySchema = z
  .object({
    deliveryMode: DeliveryModeSchema.optional(),
  })
  .strict()
  .optional();

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

function resolveClaimBaseUrl(): string {
  const env = getEnv();
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `http://${env.HOST}:${env.PORT}`;
}

function buildClaimUrl(rawToken: string): string {
  return `${resolveClaimBaseUrl()}/integrations/claim/${encodeURIComponent(rawToken)}`;
}

async function dispatchClaimEmail(params: {
  to: string;
  link: string;
  domain: string;
}): Promise<boolean> {
  // The accept/resend transaction has already committed by the time we get here,
  // so a throw would leave the admin thinking nothing happened even though a
  // claim token exists. Await the send so we can surface the outcome in the
  // response and the admin can decide to re-trigger /resend-claim.
  try {
    await sendIntegrationApprovedEmail(params);
    return true;
  } catch (err) {
    getAppLogger().error(
      { err, domain: params.domain },
      'failed to dispatch integration approval email',
    );
    return false;
  }
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
    '/internal/admin/integration-requests/:id/accept',
    adminRoute(objectSchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const body = AcceptBodySchema.parse(request.body ?? undefined);
      const reviewerEmail = requireActorEmail(request);

      const result = await acceptIntegrationRequest({
        id,
        reviewerEmail,
        label: body?.label,
        clientSecret: body?.clientSecret,
      });

      const deliveryMode = body?.deliveryMode ?? 'email';
      const emailDispatched = deliveryMode === 'email'
        ? await dispatchClaimEmail({
            to: result.integration.contactEmail,
            link: buildClaimUrl(result.claim.rawToken),
            domain: result.integration.domain,
          })
        : false;

      return {
        ...toAdminDetail(result.integration),
        delivery_mode: deliveryMode,
        email_dispatched: emailDispatched,
        ...(deliveryMode === 'reveal'
          ? {
              credentials: {
                domain: result.integration.domain,
                client_secret: result.rawClientSecret,
                client_hash: result.clientHash,
                hash_prefix: result.hashPrefix,
              },
            }
          : {}),
      };
    },
  );

  app.post(
    '/internal/admin/integration-requests/:id/resend-claim',
    adminRoute(objectSchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const body = ResendBodySchema.parse(request.body ?? undefined);
      const actorEmail = requireActorEmail(request);

      const result = await resendIntegrationClaim({ id, actorEmail });

      const deliveryMode = body?.deliveryMode ?? 'email';
      const emailDispatched = deliveryMode === 'email'
        ? await dispatchClaimEmail({
            to: result.integration.contactEmail,
            link: buildClaimUrl(result.claim.rawToken),
            domain: result.integration.domain,
          })
        : false;

      return {
        ...toAdminDetail(result.integration),
        delivery_mode: deliveryMode,
        email_dispatched: emailDispatched,
        ...(deliveryMode === 'reveal'
          ? {
              credentials: {
                domain: result.integration.domain,
                client_secret: result.rawClientSecret,
                client_hash: result.clientHash,
                hash_prefix: result.hashPrefix,
              },
            }
          : {}),
      };
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
      return toAdminDetail(row);
    },
  );

  app.delete(
    '/internal/admin/integration-requests/:id',
    adminRoute(emptySchema),
    async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);
      await deleteIntegrationRequest({ id, actorEmail });
      return { ok: true };
    },
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import {
  approveAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
} from '../../services/access-request.service.js';
import { AppError } from '../../utils/errors.js';

const DomainQuerySchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toLowerCase().replace(/\.$/, '')),
    config_url: z.string().trim().min(1),
    status: z.string().trim().min(1).optional(),
  })
  .passthrough();

const PathSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});

const RequestPathSchema = PathSchema.extend({
  requestId: z.string().trim().min(1),
});

const ReviewBodySchema = z.object({
  reviewedByUserId: z.string().trim().min(1).optional(),
  reviewReason: z.string().trim().max(500).optional(),
});

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  request.config = {
    ...(request.config ?? {}),
    domain: parsed.domain,
  } as typeof request.config;
  return parsed;
}

async function parseDomainContextHook(request: FastifyRequest): Promise<void> {
  parseDomainContext(request);
}

export function registerAccessRequestRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/teams/:teamId/access-requests',
    {
      preValidation: [
        parseDomainContextHook,
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { status } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId } = PathSchema.parse(request.params);

      const result = await listAccessRequests({
        orgId,
        teamId,
        config,
        status,
      });

      reply.status(200).send(result);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/approve',
    {
      preValidation: [
        parseDomainContextHook,
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId, requestId } = RequestPathSchema.parse(request.params);
      const body = ReviewBodySchema.parse(request.body ?? {});

      const result = await approveAccessRequest({
        orgId,
        teamId,
        requestId,
        config,
        reviewedByUserId: body.reviewedByUserId,
        reviewReason: body.reviewReason,
      });

      reply.status(200).send(result);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/reject',
    {
      preValidation: [
        parseDomainContextHook,
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId, requestId } = RequestPathSchema.parse(request.params);
      const body = ReviewBodySchema.parse(request.body ?? {});

      const result = await rejectAccessRequest({
        orgId,
        teamId,
        requestId,
        config,
        reviewedByUserId: body.reviewedByUserId,
        reviewReason: body.reviewReason,
      });

      reply.status(200).send(result);
    },
  );
}

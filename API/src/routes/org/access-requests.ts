import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  approveAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
} from '../../services/access-request.service.js';
import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

const DomainQuerySchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .transform(normalizeDomain),
    config_url: z.string().trim().min(1),
    status: z.string().trim().min(1).optional(),
  })
  .strict();

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
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
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
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { status } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId } = PathSchema.parse(request.params);

      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        listAccessRequests(
          { orgId, teamId, config, status },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/approve',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId, requestId } = RequestPathSchema.parse(request.params);
      const body = ReviewBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        approveAccessRequest(
          {
            orgId,
            teamId,
            requestId,
            config,
            reviewedByUserId: body.reviewedByUserId,
            reviewReason: body.reviewReason,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/reject',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      const { orgId, teamId, requestId } = RequestPathSchema.parse(request.params);
      const body = ReviewBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        rejectAccessRequest(
          {
            orgId,
            teamId,
            requestId,
            config,
            reviewedByUserId: body.reviewedByUserId,
            reviewReason: body.reviewReason,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );
}

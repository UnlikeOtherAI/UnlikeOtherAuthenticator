import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../../db/tenant-context.js';
import { configVerifier } from '../../../middleware/config-verifier.js';
import { requireGroupsEnabled } from '../../../middleware/groups-enabled.js';
import requireDomainHashAuthForDomainQuery from '../../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../../middleware/org-features.js';
import { setTenantContextFromRequest } from '../../../plugins/tenant-context.plugin.js';
import { createGroup, updateGroup, deleteGroup } from '../../../services/group.service.js';
import { AppError } from '../../../utils/errors.js';
import {
  assertVerifiedDomainMatchesQuery,
  normalizeDomain,
} from '../../org/domain-context.js';

const DomainQuerySchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .transform(normalizeDomain),
    config_url: z.string().trim().min(1),
  })
  .strict();

const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

const GroupPathSchema = z.object({
  orgId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
});

const GroupBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
});

const GroupUpdateBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
}

async function parseDomainContextHook(request: FastifyRequest): Promise<void> {
  parseDomainContext(request);
}

function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

function getGroupIdFromParams(params: unknown): string {
  const parsed = GroupPathSchema.parse(params ?? {});
  return parsed.groupId;
}

export function registerInternalGroupRoutes(app: FastifyInstance): void {
  app.post(
    '/internal/org/organisations/:orgId/groups',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireGroupsEnabled,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const body = GroupBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const group = await request.withTenantTx((tx) =>
        createGroup(
          {
            orgId,
            domain,
            name: body.name,
            description: body.description ?? undefined,
            config,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(group);
    },
  );

  app.put(
    '/internal/org/organisations/:orgId/groups/:groupId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireGroupsEnabled,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const groupId = getGroupIdFromParams(request.params);
      const body = GroupUpdateBodySchema.parse(request.body ?? {});
      if (!Object.hasOwn(body, 'name') && !Object.hasOwn(body, 'description')) {
        throw new AppError('BAD_REQUEST', 400);
      }

      setTenantContextFromRequest(request, { orgId });
      const group = await request.withTenantTx((tx) =>
        updateGroup(
          {
            orgId,
            groupId,
            domain,
            config,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(group);
    },
  );

  app.delete(
    '/internal/org/organisations/:orgId/groups/:groupId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireGroupsEnabled,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const groupId = getGroupIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      await request.withTenantTx((tx) =>
        deleteGroup(
          {
            orgId,
            groupId,
            domain,
            config,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );
}

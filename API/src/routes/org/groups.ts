import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireGroupsEnabled } from '../../middleware/groups-enabled.js';
import { getGroup, listGroups } from '../../services/group.service.js';
import { AppError } from '../../utils/errors.js';

const DomainQuerySchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toLowerCase().replace(/\.$/, '')),
    config_url: z.string().trim().min(1),
  })
  .passthrough();

const ListQuerySchema = DomainQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
}).passthrough();

const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

const GroupPathSchema = OrgPathSchema.extend({
  groupId: z.string().trim().min(1),
});

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);

  request.config = {
    ...(request.config ?? {}),
    domain: parsed.domain,
  } as typeof request.config;

  return parsed;
}

function parseLimitCursor(request: FastifyRequest) {
  return ListQuerySchema.parse(request.query);
}

function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

function getGroupIdFromParams(params: unknown): string {
  const parsed = GroupPathSchema.parse(params ?? {});
  return parsed.groupId;
}

export function registerGroupRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/groups',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireGroupsEnabled,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);

      const groups = await listGroups({
        orgId,
        domain,
        config,
        limit,
        cursor,
      });

      reply.status(200).send(groups);
    },
  );

  app.get(
    '/org/organisations/:orgId/groups/:groupId',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireGroupsEnabled,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const groupId = getGroupIdFromParams(request.params);

      const group = await getGroup({
        orgId,
        groupId,
        domain,
        config,
      });

      reply.status(200).send(group);
    },
  );
}

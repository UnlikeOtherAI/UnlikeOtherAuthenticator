import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireGroupsEnabled } from '../../middleware/groups-enabled.js';
import { listGroups } from '../../services/group.service.js';
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

function parseDomainContext(
  request: FastifyRequest<{
    Querystring: { domain?: string; config_url?: string; [key: string]: unknown };
  }>,
) {
  const parsed = DomainQuerySchema.parse(request.query);

  request.config = {
    ...(request.config ?? {}),
    domain: parsed.domain,
  };

  return parsed;
}

function parseLimitCursor(
  request: FastifyRequest<{
    Querystring: { limit?: string | number; cursor?: string; [key: string]: unknown };
  }>,
) {
  return ListQuerySchema.parse(request.query);
}

function getOrgIdFromParams(params: { orgId?: string } | undefined): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
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
}

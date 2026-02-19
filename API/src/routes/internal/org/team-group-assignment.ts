import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../../middleware/config-verifier.js';
import { requireGroupsEnabled } from '../../../middleware/groups-enabled.js';
import requireDomainHashAuthForDomainQuery from '../../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../../middleware/org-features.js';
import { assignTeamToGroup } from '../../../services/group.service.js';
import { AppError } from '../../../utils/errors.js';

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

const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

const TeamPathSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});

const TeamGroupBodySchema = z.object({
  groupId: z.union([z.string().trim().min(1), z.null()]),
});

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  request.config = {
    ...(request.config ?? {}),
    domain: parsed.domain,
  } as typeof request.config;
  return parsed;
}

function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

function getTeamIdFromParams(params: unknown): string {
  const parsed = TeamPathSchema.pick({ teamId: true }).parse(params ?? {});
  return parsed.teamId;
}

export function registerInternalTeamGroupAssignmentRoutes(app: FastifyInstance): void {
  app.put(
    '/internal/org/organisations/:orgId/teams/:teamId/group',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireGroupsEnabled,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const body = TeamGroupBodySchema.parse(request.body ?? {});

      const team = await assignTeamToGroup({
        orgId,
        teamId,
        domain,
        groupId: body.groupId,
        config,
      });

      reply.status(200).send(team);
    },
  );
}

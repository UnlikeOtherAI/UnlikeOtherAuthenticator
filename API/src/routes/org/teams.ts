import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import {
  addTeamMember,
  changeTeamMemberRole,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeam,
} from '../../services/team.service.js';
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

const TeamPathSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});

const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

const TeamBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
});

const TeamUpdateBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

const AddTeamMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  teamRole: z.string().trim().min(1).optional(),
});

const ChangeTeamMemberRoleBodySchema = z.object({
  teamRole: z.string().trim().min(1),
});

type RequestWithClaims = FastifyRequest & {
  accessTokenClaims?: {
    userId: string;
  };
};

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);

  request.config = {
    ...(request.config ?? {}),
    domain: parsed.domain,
  } as typeof request.config;

  return parsed;
}

function parseDomainFromRequest(request: FastifyRequest): string {
  const parsed = DomainQuerySchema.parse(request.query);
  return parsed.domain;
}

function parseLimitCursor(request: FastifyRequest) {
  return ListQuerySchema.parse(request.query);
}

function getActorUserId(request: RequestWithClaims): string {
  const userId = request.accessTokenClaims?.userId;
  if (!userId) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  return userId;
}

function getOrgIdFromParams(params: unknown): string {
  const parsed = OrgPathSchema.parse(params ?? {});
  return parsed.orgId;
}

function getTeamIdFromParams(params: unknown): string {
  const parsed = TeamPathSchema.parse(params ?? {});
  return parsed.teamId;
}

function getMemberUserIdFromParams(params: unknown): string {
  const parsed = z.object({ userId: z.string().trim().min(1) }).parse(params ?? {});
  return parsed.userId;
}

function keyCreateTeamRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const orgId = getOrgIdFromParams(request.params);
  return `org:create-team:${domain}:${orgId}`;
}

export function registerTeamRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/teams',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      const orgId = getOrgIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      const teams = await listTeams({
        orgId,
        domain,
        actorUserId,
        limit,
        cursor,
      });

      reply.status(200).send(teams);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireOrgRole(),
        createRateLimiter({
          limit: 50,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyCreateTeamRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const actorUserId = getActorUserId(request as RequestWithClaims);
      const orgId = getOrgIdFromParams(request.params);
      const body = TeamBodySchema.parse(request.body ?? {});

      const team = await createTeam({
        orgId,
        domain,
        actorUserId,
        name: body.name,
        description: body.description ?? undefined,
        config,
      });

      reply.status(200).send(team);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      const team = await getTeam({
        orgId,
        teamId,
        domain,
        actorUserId,
      });

      reply.status(200).send(team);
    },
  );

  app.put(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const body = TeamUpdateBodySchema.parse(request.body ?? {});

      if (!Object.hasOwn(body, 'name') && !Object.hasOwn(body, 'description')) {
        throw new AppError('BAD_REQUEST', 400);
      }

      const team = await updateTeam({
        orgId,
        teamId,
        domain,
        actorUserId,
        name: body.name,
        description: body.description,
      });

      reply.status(200).send(team);
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await deleteTeam({
        orgId,
        teamId,
        domain,
        actorUserId,
      });

      reply.status(200).send({ ok: true });
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/members',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { userId, teamRole } = AddTeamMemberBodySchema.parse(request.body ?? {});

      const member = await addTeamMember({
        orgId,
        teamId,
        domain,
        actorUserId,
        userId,
        teamRole,
        config,
      });

      reply.status(200).send(member);
    },
  );

  app.put(
    '/org/organisations/:orgId/teams/:teamId/members/:userId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { teamRole } = ChangeTeamMemberRoleBodySchema.parse(request.body ?? {});

      const member = await changeTeamMemberRole({
        orgId,
        teamId,
        domain,
        actorUserId,
        userId,
        teamRole,
      });

      reply.status(200).send(member);
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId/members/:userId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await removeTeamMember({
        orgId,
        teamId,
        domain,
        actorUserId,
        userId,
      });

      reply.status(200).send({ ok: true });
    },
  );
}

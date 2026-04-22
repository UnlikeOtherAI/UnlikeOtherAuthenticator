import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
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
import {
  AddTeamMemberBodySchema,
  ChangeTeamMemberRoleBodySchema,
  TeamBodySchema,
  TeamUpdateBodySchema,
  type RequestWithClaims,
  getActorUserId,
  getMemberUserIdFromParams,
  getOrgIdFromParams,
  getTeamIdFromParams,
  keyCreateTeamRateLimit,
  parseDomainContext,
  parseDomainContextHook,
  parseLimitCursor,
} from './team-route.shared.js';

export function registerTeamRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/teams',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      const orgId = getOrgIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const teams = await request.withTenantTx((tx) =>
        listTeams(
          { orgId, domain, actorUserId, limit, cursor },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(teams);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
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

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const team = await request.withTenantTx((tx) =>
        createTeam(
          {
            orgId,
            domain,
            actorUserId,
            name: body.name,
            slug: body.slug,
            description: body.description ?? undefined,
            config,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(team);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const team = await request.withTenantTx((tx) =>
        getTeam(
          { orgId, teamId, domain, actorUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(team);
    },
  );

  app.put(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const body = TeamUpdateBodySchema.parse(request.body ?? {});

      if (
        !Object.hasOwn(body, 'name') &&
        !Object.hasOwn(body, 'slug') &&
        !Object.hasOwn(body, 'description')
      ) {
        throw new AppError('BAD_REQUEST', 400);
      }

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const team = await request.withTenantTx((tx) =>
        updateTeam(
          {
            orgId,
            teamId,
            domain,
            actorUserId,
            name: body.name,
            slug: body.slug,
            description: body.description,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(team);
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      await request.withTenantTx((tx) =>
        deleteTeam(
          { orgId, teamId, domain, actorUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/members',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { userId, teamRole } = AddTeamMemberBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const member = await request.withTenantTx((tx) =>
        addTeamMember(
          { orgId, teamId, domain, actorUserId, userId, teamRole, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(member);
    },
  );

  app.put(
    '/org/organisations/:orgId/teams/:teamId/members/:userId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { teamRole } = ChangeTeamMemberRoleBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const member = await request.withTenantTx((tx) =>
        changeTeamMemberRole(
          { orgId, teamId, domain, actorUserId, userId, teamRole },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(member);
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId/members/:userId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      await request.withTenantTx((tx) =>
        removeTeamMember(
          { orgId, teamId, domain, actorUserId, userId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );
}

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
  findTeamMemberCandidates,
  listTeamMembers,
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
  getMemberUserIdFromParams,
  getOrgIdFromParams,
  getTeamIdFromParams,
  keyCreateTeamRateLimit,
  orgCaller,
  parseDomainContext,
  parseDomainContextHook,
  parseLimitCursor,
  parseTeamMemberCandidatesQuery,
  parseTeamDetailQuery,
  parseTeamMembersRosterQuery,
  requireVerifiedConfig,
  tenantUserId,
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

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const teams = await request.withTenantTx((tx) =>
        listTeams(
          { orgId, domain, ...orgCaller(request), limit, cursor },
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
      const config = requireVerifiedConfig(request);

      const orgId = getOrgIdFromParams(request.params);
      const body = TeamBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const team = await request.withTenantTx((tx) =>
        createTeam(
          {
            orgId,
            domain,
            ...orgCaller(request),
            name: body.name,
            slug: body.slug,
            description: body.description ?? undefined,
            joinCreator: body.join_creator ?? false,
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
      const { domain, include } = parseTeamDetailQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      // Gap-fix A Task 2: exact literal only — any other value behaves like the param is absent.
      const includeInvited = include === 'invited';

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const team = await request.withTenantTx((tx) =>
        getTeam(
          {
            orgId,
            teamId,
            domain,
            ...orgCaller(request),
            includeInvited,
            config: requireVerifiedConfig(request),
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(team);
    },
  );

  app.get(
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
      const { domain, limit, cursor, direction, status } = parseTeamMembersRosterQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const config = requireVerifiedConfig(request);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const roster = await request.withTenantTx((tx) =>
        listTeamMembers(
          {
            orgId,
            teamId,
            domain,
            ...orgCaller(request),
            config,
            limit,
            cursor,
            direction,
            status,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(roster);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId/members/candidates',
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
      const { domain, q, limit, cursor, direction } = parseTeamMemberCandidatesQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const config = requireVerifiedConfig(request);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const candidates = await request.withTenantTx((tx) =>
        findTeamMemberCandidates(
          { orgId, teamId, domain, ...orgCaller(request), config, q, limit, cursor, direction },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(candidates);
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
      const body = TeamUpdateBodySchema.parse(request.body ?? {});

      if (
        !Object.hasOwn(body, 'name') &&
        !Object.hasOwn(body, 'slug') &&
        !Object.hasOwn(body, 'description') &&
        !Object.hasOwn(body, 'joinPolicy') &&
        !Object.hasOwn(body, 'icon_url')
      ) {
        throw new AppError('BAD_REQUEST', 400);
      }

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const team = await request.withTenantTx((tx) =>
        updateTeam(
          {
            orgId,
            teamId,
            domain,
            ...orgCaller(request),
            name: body.name,
            slug: body.slug,
            description: body.description,
            joinPolicy: body.joinPolicy,
            iconUrl: body.icon_url,
            config: requireVerifiedConfig(request),
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

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      await request.withTenantTx((tx) =>
        deleteTeam(
          { orgId, teamId, domain, ...orgCaller(request), config: requireVerifiedConfig(request) },
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
      const config = requireVerifiedConfig(request);

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const { userId, teamRole } = AddTeamMemberBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const member = await request.withTenantTx((tx) =>
        addTeamMember(
          {
            orgId,
            teamId,
            domain,
            ...orgCaller(request),
            userId,
            teamRole,
            config,
          },
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
      const { teamRole } = ChangeTeamMemberRoleBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const member = await request.withTenantTx((tx) =>
        changeTeamMemberRole(
          {
            orgId,
            teamId,
            domain,
            ...orgCaller(request),
            userId,
            teamRole,
            config: requireVerifiedConfig(request),
          },
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

      await removeTeamMember(
        {
          orgId,
          teamId,
          domain,
          ...orgCaller(request),
          userId,
          config: requireVerifiedConfig(request),
        },
        { prisma: request.adminDb },
      );

      reply.status(200).send({ ok: true });
    },
  );
}

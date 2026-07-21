import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  listOrganisationMembers,
  addOrganisationMember,
  changeOrganisationMemberRole,
  removeOrganisationMember,
  transferOrganisationOwnership,
} from '../../services/organisation.service.members.js';
import {
  deactivateOrganisationMember,
  reactivateOrganisationMember,
} from '../../services/organisation.service.lifecycle.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { AppError } from '../../utils/errors.js';
import {
  AddMemberBodySchema,
  SetRoleBodySchema,
  type RequestWithClaims,
  getActorUserId,
  getOrgIdFromParams,
  getTransferOwnerId,
  getUserIdFromParams,
  keyAddMemberRateLimit,
  parseDomainContext,
  parseDomainContextHook,
  parseMembersListQuery,
} from './organisation-route.shared.js';

// Organisation member management routes, split out of organisations.ts (which covers org
// CRUD only) to keep both files under the project's 500-line limit.
export function registerOrganisationMemberRoutes(app: FastifyInstance) {
  app.get(
    '/org/organisations/:orgId/members',
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
      const { domain, limit, cursor, status } = parseMembersListQuery(request);
      const orgId = getOrgIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const members = await request.withTenantTx((tx) =>
        listOrganisationMembers(
          { orgId, domain, limit, cursor, status },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(members);
    },
  );

  app.post(
    '/org/organisations/:orgId/members',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
        createRateLimiter({
          limit: 100,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyAddMemberRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { userId, role } = AddMemberBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const member = await request.withTenantTx((tx) =>
        addOrganisationMember(
          { orgId, domain, actorUserId, userId, role: role ?? 'member', config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(member);
    },
  );

  app.put(
    '/org/organisations/:orgId/members/:userId',
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
      const userId = getUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { role } = SetRoleBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const member = await request.withTenantTx((tx) =>
        changeOrganisationMemberRole(
          { orgId, domain, actorUserId, userId, role, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(member);
    },
  );

  app.delete(
    '/org/organisations/:orgId/members/:userId',
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
      const userId = getUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await removeOrganisationMember(
        { orgId, domain, actorUserId, userId },
        { prisma: request.adminDb },
      );

      reply.status(200).send({ ok: true });
    },
  );

  app.post(
    '/org/organisations/:orgId/members/:userId/deactivate',
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
      const userId = getUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await deactivateOrganisationMember(
        { orgId, domain, actorUserId, userId },
        { prisma: request.adminDb },
      );

      reply.status(200).send({ ok: true });
    },
  );

  app.post(
    '/org/organisations/:orgId/members/:userId/reactivate',
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
      const userId = getUserIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      await request.withTenantTx((tx) =>
        reactivateOrganisationMember(
          { orgId, domain, actorUserId, userId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );

  const transferOwnershipHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { domain } = parseDomainContext(request);
    const orgId = getOrgIdFromParams(request.params);
    const newOwnerId = getTransferOwnerId((request.body ?? {}) as Record<string, unknown>);

    const actorUserId = getActorUserId(request as RequestWithClaims);

    setTenantContextFromRequest(request, { orgId, userId: actorUserId });
    const org = await request.withTenantTx((tx) =>
      transferOrganisationOwnership(
        { orgId, domain, actorUserId, newOwnerId },
        { prisma: asPrismaClient(tx) },
      ),
    );

    reply.status(200).send(org);
  };

  app.post(
    '/org/organisations/:orgId/transfer-ownership',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    transferOwnershipHandler,
  );
}

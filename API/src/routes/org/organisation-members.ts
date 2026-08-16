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
} from '../../services/organisation.service.members.js';
import { transferOrganisationOwnership } from '../../services/organisation.service.ownership.js';
import {
  deactivateOrganisationMember,
  reactivateOrganisationMember,
} from '../../services/organisation.service.lifecycle.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import {
  AddMemberBodySchema,
  SetRoleBodySchema,
  getOrgIdFromParams,
  getUserIdFromParams,
  keyAddMemberRateLimit,
  orgCaller,
  parseDomainContext,
  parseDomainContextHook,
  parseMembersListQuery,
  parseTransferOwnershipBody,
  requireVerifiedConfig,
  tenantUserId,
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
      const config = requireVerifiedConfig(request);

      const orgId = getOrgIdFromParams(request.params);
      const { userId, role } = AddMemberBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const member = await request.withTenantTx((tx) =>
        addOrganisationMember(
          {
            orgId,
            domain,
            ...orgCaller(request),
            userId,
            role: role ?? 'member',
            config,
          },
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
      const config = requireVerifiedConfig(request);

      const orgId = getOrgIdFromParams(request.params);
      const userId = getUserIdFromParams(request.params);
      const { role } = SetRoleBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const member = await request.withTenantTx((tx) =>
        changeOrganisationMemberRole(
          {
            orgId,
            domain,
            ...orgCaller(request),
            userId,
            role,
            config,
          },
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
      const config = requireVerifiedConfig(request);
      const orgId = getOrgIdFromParams(request.params);
      const userId = getUserIdFromParams(request.params);

      await removeOrganisationMember(
        { orgId, domain, ...orgCaller(request), userId, config },
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
      const config = requireVerifiedConfig(request);
      const orgId = getOrgIdFromParams(request.params);
      const userId = getUserIdFromParams(request.params);

      await deactivateOrganisationMember(
        { orgId, domain, ...orgCaller(request), userId, config },
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
      const config = requireVerifiedConfig(request);
      const orgId = getOrgIdFromParams(request.params);
      const userId = getUserIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      await request.withTenantTx((tx) =>
        reactivateOrganisationMember(
          { orgId, domain, ...orgCaller(request), userId, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );

  const transferOwnershipHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { domain } = parseDomainContext(request);
    const config = requireVerifiedConfig(request);
    const orgId = getOrgIdFromParams(request.params);
    const { newOwnerId, previousOwnerRole } = parseTransferOwnershipBody(
      (request.body ?? {}) as Record<string, unknown>,
    );

    setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
    const org = await request.withTenantTx((tx) =>
      transferOrganisationOwnership(
        { orgId, domain, ...orgCaller(request), newOwnerId, previousOwnerRole, config },
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

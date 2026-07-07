import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  createOrganisation,
  deleteOrganisation,
  getOrganisation,
  listOrganisationsForDomain,
  updateOrganisation,
} from '../../services/organisation.service.organisation.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { AppError } from '../../utils/errors.js';
import {
  OrgBodySchema,
  type RequestWithClaims,
  getActorUserId,
  getOrgIdFromParams,
  keyCreateOrganisationRateLimit,
  parseDomainContext,
  parseDomainContextHook,
  parseLimitCursor,
} from './organisation-route.shared.js';

export function registerOrganisationRoutes(app: FastifyInstance) {
  // VM2: this list endpoint is intentionally backend-to-backend. The domain hash
  // bearer token is the authorization boundary; user-scoped reads use /org/me.
  app.get(
    '/org/organisations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      // /org/organisations list uses organisations bootstrap predicate
      // (domain + membership); app.org_id left empty intentionally.
      setTenantContextFromRequest(request, { orgId: null });
      const page = await request.withTenantTx((tx) =>
        listOrganisationsForDomain(
          { domain, limit, cursor },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(page);
    },
  );

  app.post(
    '/org/organisations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
        createRateLimiter({
          limit: 5,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyCreateOrganisationRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const { name } = OrgBodySchema.parse(request.body ?? {});
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const claims = (request as RequestWithClaims).accessTokenClaims;
      const isSuperuser = claims?.role === 'superuser';
      if (!isSuperuser && !config.org_features?.allow_user_create_org) {
        throw new AppError('FORBIDDEN', 403, 'ORG_CREATION_NOT_ALLOWED');
      }

      // Create uses the organisations bootstrap branch (domain + owner_id matches
      // app.user_id); app.org_id is not yet known.
      setTenantContextFromRequest(request, { orgId: null, userId: actorUserId });
      const org = await request.withTenantTx((tx) =>
        createOrganisation(
          { domain, name, ownerId: actorUserId, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(org);
    },
  );

  app.get(
    '/org/organisations/:orgId',
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
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const org = await request.withTenantTx((tx) =>
        getOrganisation({ orgId, domain, actorUserId }, { prisma: asPrismaClient(tx) }),
      );

      reply.status(200).send(org);
    },
  );

  app.put(
    '/org/organisations/:orgId',
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
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { name } = OrgBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      const org = await request.withTenantTx((tx) =>
        updateOrganisation(
          { orgId, domain, name, actorUserId, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(org);
    },
  );

  app.delete(
    '/org/organisations/:orgId',
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
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      await request.withTenantTx((tx) =>
        deleteOrganisation(
          { orgId, domain, actorUserId },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );
}

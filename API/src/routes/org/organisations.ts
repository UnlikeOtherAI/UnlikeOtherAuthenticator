import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

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
import {
  listOrganisationMembers,
  addOrganisationMember,
  changeOrganisationMemberRole,
  removeOrganisationMember,
  transferOrganisationOwnership,
} from '../../services/organisation.service.members.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { AppError } from '../../utils/errors.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

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

const ListQuerySchema = DomainQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
}).strict();

const OrgPathSchema = z.object({
  orgId: z.string().trim().min(1),
});

const OrgBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

const AddMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
});

const SetRoleBodySchema = z.object({
  role: z.string().trim().min(1),
});

const TransferOwnershipBodySchema = z
  .object({
    newOwnerId: z.string().trim().min(1).optional(),
    newOwnerUserId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.newOwnerId && !value.newOwnerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'newOwnerId or newOwnerUserId is required.',
        path: ['newOwnerId'],
      });
    }
    if (value.newOwnerId && value.newOwnerUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either newOwnerId or newOwnerUserId.',
        path: ['newOwnerUserId'],
      });
    }
  });

type RequestWithClaims = FastifyRequest & {
  accessTokenClaims?: {
    userId: string;
    org?: {
      org_id: string;
    };
  };
};

function parseDomainContext(request: FastifyRequest) {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);

  return parsed;
}

// Async wrapper for use in Fastify preValidation arrays. Fastify's hook runner only
// continues the chain when a hook returns a Promise or calls next(). parseDomainContext
// returns a plain object (for direct handler use), so we wrap it here.
async function parseDomainContextHook(request: FastifyRequest): Promise<void> {
  parseDomainContext(request);
}

function parseDomainFromRequest(request: FastifyRequest): string {
  const parsed = DomainQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed.domain;
}

function parseLimitCursor(request: FastifyRequest) {
  const parsed = ListQuerySchema.parse(request.query);
  assertVerifiedDomainMatchesQuery(request, parsed.domain);
  return parsed;
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

function getTransferOwnerId(body: Record<string, unknown>): string {
  const parsed = TransferOwnershipBodySchema.parse(body);
  const id = parsed.newOwnerId ?? parsed.newOwnerUserId;
  if (!id) throw new AppError('BAD_REQUEST', 400, 'MISSING_NEW_OWNER');
  return id;
}

function keyCreateOrganisationRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const actor = getActorUserId(request as RequestWithClaims);
  return `org:create:${domain}:${actor}`;
}

function keyAddMemberRateLimit(request: FastifyRequest) {
  const domain = parseDomainFromRequest(request);
  const parsedOrg = OrgPathSchema.parse(request.params);
  return `org:add-member:${domain}:${parsedOrg.orgId}`;
}

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

      setTenantContextFromRequest(request, { orgId });
      const org = await request.withTenantTx((tx) =>
        getOrganisation({ orgId, domain }, { prisma: asPrismaClient(tx) }),
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
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const { limit, cursor } = parseLimitCursor(request);

      setTenantContextFromRequest(request, { orgId });
      const members = await request.withTenantTx((tx) =>
        listOrganisationMembers(
          { orgId, domain, limit, cursor },
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
      const userId = z.object({ userId: z.string().trim().min(1) }).parse(request.params).userId;
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
      const userId = z.object({ userId: z.string().trim().min(1) }).parse(request.params).userId;
      const actorUserId = getActorUserId(request as RequestWithClaims);

      setTenantContextFromRequest(request, { orgId, userId: actorUserId });
      await request.withTenantTx((tx) =>
        removeOrganisationMember(
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

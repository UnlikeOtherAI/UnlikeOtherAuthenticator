import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
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
  app.get(
    '/org/organisations',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      const page = await listOrganisationsForDomain({
        domain,
        limit,
        cursor,
      });

      reply.status(200).send(page);
    },
  );

  app.post(
    '/org/organisations',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
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

      const org = await createOrganisation({
        domain,
        name,
        ownerId: actorUserId,
        config,
      });

      reply.status(200).send(org);
    },
  );

  app.get(
    '/org/organisations/:orgId',
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

      const org = await getOrganisation({ orgId, domain });

      reply.status(200).send(org);
    },
  );

  app.put(
    '/org/organisations/:orgId',
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
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { name } = OrgBodySchema.parse(request.body ?? {});

      const org = await updateOrganisation({
        orgId,
        domain,
        name,
        actorUserId,
        config,
      });

      reply.status(200).send(org);
    },
  );

  app.delete(
    '/org/organisations/:orgId',
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
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await deleteOrganisation({
        orgId,
        domain,
        actorUserId,
      });

      reply.status(200).send({ ok: true });
    },
  );

  app.get(
    '/org/organisations/:orgId/members',
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
      const { limit, cursor } = parseLimitCursor(request);

      const members = await listOrganisationMembers({
        orgId,
        domain,
        limit,
        cursor,
      });

      reply.status(200).send(members);
    },
  );

  app.post(
    '/org/organisations/:orgId/members',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
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

      const member = await addOrganisationMember({
        orgId,
        domain,
        actorUserId,
        userId,
        role: role ?? 'member',
        config,
      });

      reply.status(200).send(member);
    },
  );

  app.put(
    '/org/organisations/:orgId/members/:userId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const userId = z.object({ userId: z.string().trim().min(1) }).parse(request.params).userId;
      const actorUserId = getActorUserId(request as RequestWithClaims);
      const { role } = SetRoleBodySchema.parse(request.body ?? {});

      const member = await changeOrganisationMemberRole({
        orgId,
        domain,
        actorUserId,
        userId,
        role,
        config,
      });

      reply.status(200).send(member);
    },
  );

  app.delete(
    '/org/organisations/:orgId/members/:userId',
    {
      preValidation: [parseDomainContext, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures, requireOrgRole()],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const userId = z.object({ userId: z.string().trim().min(1) }).parse(request.params).userId;
      const actorUserId = getActorUserId(request as RequestWithClaims);

      await removeOrganisationMember({
        orgId,
        domain,
        actorUserId,
        userId,
      });

      reply.status(200).send({ ok: true });
    },
  );

  const transferOwnershipHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const { domain } = parseDomainContext(request);
    const orgId = getOrgIdFromParams(request.params);
    const newOwnerId = getTransferOwnerId((request.body ?? {}) as Record<string, unknown>);

    const actorUserId = getActorUserId(request as RequestWithClaims);

    const org = await transferOrganisationOwnership({
      orgId,
      domain,
      actorUserId,
      newOwnerId,
    });

    reply.status(200).send(org);
  };

  app.post('/org/organisations/:orgId/transfer-ownership', {
    preValidation: [
      parseDomainContext,
      configVerifier,
      requireDomainHashAuthForDomainQuery(),
      requireOrgFeatures,
      requireOrgRole(),
    ],
  }, transferOwnershipHandler);

  app.post(
    '/org/organisations/:orgId/ownership-transfer',
    {
      preValidation: [
        parseDomainContext,
        configVerifier,
        requireDomainHashAuthForDomainQuery(),
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    transferOwnershipHandler,
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../../middleware/config-verifier.js';
import { requireGroupsEnabled } from '../../../middleware/groups-enabled.js';
import requireDomainHashAuthForDomainQuery from '../../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../../middleware/org-features.js';
import { addGroupMember, removeGroupMember, updateGroupMemberAdmin } from '../../../services/group.service.js';
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

const GroupPathSchema = z.object({
  orgId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
});

const MemberPathSchema = z.object({
  orgId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
});

const AddMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  isAdmin: z.boolean().optional(),
});

const AdminFlagBodySchema = z.object({
  isAdmin: z.boolean(),
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

function getOrgIdFromParams(params: { orgId?: string } | undefined): string {
  const parsed = GroupPathSchema.pick({ orgId: true }).parse(params ?? {});
  return parsed.orgId;
}

function getGroupIdFromParams(params: { orgId?: string; groupId?: string } | undefined): string {
  const parsed = GroupPathSchema.parse(params ?? {});
  return parsed.groupId;
}

function getMemberUserIdFromParams(params: { userId?: string } | undefined): string {
  const parsed = MemberPathSchema.pick({ userId: true }).parse(params ?? {});
  return parsed.userId;
}

export function registerInternalGroupMemberRoutes(app: FastifyInstance): void {
  app.post(
    '/internal/org/organisations/:orgId/groups/:groupId/members',
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
      const groupId = getGroupIdFromParams(request.params);
      const body = AddMemberBodySchema.parse(request.body ?? {});

      const member = await addGroupMember({
        orgId,
        groupId,
        domain,
        userId: body.userId,
        isAdmin: body.isAdmin,
        config,
      });

      reply.status(200).send(member);
    },
  );

  app.delete(
    '/internal/org/organisations/:orgId/groups/:groupId/members/:userId',
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
      const groupId = getGroupIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);

      await removeGroupMember({
        orgId,
        groupId,
        domain,
        userId,
        config,
      });

      reply.status(200).send({ ok: true });
    },
  );

  app.put(
    '/internal/org/organisations/:orgId/groups/:groupId/members/:userId',
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
      const groupId = getGroupIdFromParams(request.params);
      const userId = getMemberUserIdFromParams(request.params);
      const body = AdminFlagBodySchema.parse(request.body ?? {});

      const member = await updateGroupMemberAdmin({
        orgId,
        groupId,
        domain,
        userId,
        isAdmin: body.isAdmin,
        config,
      });

      reply.status(200).send(member);
    },
  );
}

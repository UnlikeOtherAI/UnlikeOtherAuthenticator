import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ClientConfig } from '../../services/config.service.js';

import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  deleteTeamAvatar,
  requireOrgTeamId,
  resolveTeamAvatar,
  uploadTeamAvatar,
} from '../../services/team-avatar.service.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  configDefaultAvatarStyle,
  readAvatarUpload,
  sendAvatar,
} from '../avatar/shared.js';
import { assertVerifiedDomainMatchesQuery } from './domain-context.js';
import {
  DomainQuerySchema,
  getOrgIdFromParams,
  getTeamIdFromParams,
  orgCaller,
  parseDomainContext,
  parseDomainContextHook,
  requireVerifiedConfig,
} from './team-route.shared.js';

/**
 * Team ("company") avatars on the `/org/*` family (Docs/Auth/avatars.md §11).
 *
 * The auth chain is the sibling team routes', unchanged: domain-hash bearer → verified signed
 * config → domain-context match → org features → access token bound to this org. Reads are open to
 * any ACTIVE org member (the same gate as `GET .../teams/:teamId`); mutations additionally require
 * the `teams.manage` capability, the same gate as `PUT .../teams/:teamId`.
 *
 * Table access runs on `request.adminDb`: `team_avatars` denies `uoa_app`, so avatar rows are never
 * touched inside a tenant transaction (the same classification as `user_avatars`).
 */

const orgTeamChain = [
  requireDomainHashAuthForDomainQuery(),
  configVerifier,
  parseDomainContextHook,
  requireOrgFeatures,
  requireOrgRole(),
];

// The GET additionally accepts `?style=`/`?size=`; the strict shared schema would reject them.
const ImageQuerySchema = DomainQuerySchema.extend({ ...AvatarImageQueryFields }).strict();

// Mutations are keyed per org + team so one team churning its logo cannot exhaust another's
// budget. Same 30/hour window as the user-avatar mutations.
const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const { domain } = parseDomainContext(request);
    const orgId = getOrgIdFromParams(request.params);
    const teamId = getTeamIdFromParams(request.params);
    return `org:team-avatar-write:${domain}:${orgId}:${teamId}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

type TeamAvatarContext = {
  domain: string;
  orgId: string;
  teamId: string;
  caller: ReturnType<typeof orgCaller>;
  config: ClientConfig;
};

function mutationContext(request: FastifyRequest): TeamAvatarContext {
  const { domain } = parseDomainContext(request);
  return {
    domain,
    orgId: getOrgIdFromParams(request.params),
    teamId: getTeamIdFromParams(request.params),
    caller: orgCaller(request),
    config: requireVerifiedConfig(request),
  };
}

export function registerTeamAvatarRoutes(app: FastifyInstance): void {
  app.get(
    '/org/organisations/:orgId/teams/:teamId/avatar',
    { preValidation: orgTeamChain },
    async (request, reply) => {
      const query = ImageQuerySchema.parse(request.query);
      assertVerifiedDomainMatchesQuery(request, query.domain);

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);

      const resolvedTeamId = await requireOrgTeamId(
        {
          orgId,
          teamId,
          domain: query.domain,
          ...orgCaller(request),
          config: requireVerifiedConfig(request),
        },
        { prisma: request.adminDb },
      );
      const avatar = await resolveTeamAvatar({
        teamId: resolvedTeamId,
        style: query.style ?? null,
        configDefaultStyle: configDefaultAvatarStyle(request, query.domain),
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  app.put(
    '/org/organisations/:orgId/teams/:teamId/avatar',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preValidation: [...orgTeamChain, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { domain, orgId, teamId, caller, config } = mutationContext(request);

      const resolvedTeamId = await requireOrgTeamId(
        { orgId, teamId, domain, ...caller, requireManager: true, config },
        { prisma: request.adminDb },
      );
      const data = await readAvatarUpload(request);

      return avatarUploadResponse(await uploadTeamAvatar({ teamId: resolvedTeamId, data }));
    },
  );

  app.delete(
    '/org/organisations/:orgId/teams/:teamId/avatar',
    {
      preValidation: [...orgTeamChain, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { domain, orgId, teamId, caller, config } = mutationContext(request);

      const resolvedTeamId = await requireOrgTeamId(
        { orgId, teamId, domain, ...caller, requireManager: true, config },
        { prisma: request.adminDb },
      );
      await deleteTeamAvatar({ teamId: resolvedTeamId });

      return { ok: true };
    },
  );
}

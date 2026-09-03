import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  deleteTeamAvatar,
  requireDomainTeamId,
  resolveTeamAvatar,
  uploadTeamAvatar,
} from '../../services/team-avatar.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  configDefaultAvatarStyle,
  optionalConfigVerifier,
  readAvatarUpload,
  recordDomainAvatarAudit,
  sendAvatar,
} from '../avatar/shared.js';

/**
 * `/domain/teams/:teamId/avatar` (Docs/Auth/avatars.md §11) — the team counterpart of
 * `/domain/users/:userId/avatar`, for product backends managing and rendering a team logo
 * with no end-user context.
 *
 * Domain-hash bearer only, deliberately: consuming products keep a bound refresh credential rather
 * than a spendable end-user access token, so the dual-auth `/org/*` routes cannot be driven from a
 * product backend. Brief §24.10 — the domain hash token represents full system trust for that
 * domain, and the backend enforces its own owner/admin gating before relaying here. The team's
 * organisation must still belong to the authenticated domain; anything else is the generic 404.
 *
 * Because the backend's own gating is the only role check, every mutation writes an `AdminAuditLog`
 * row naming the acting domain — the same traceability the `/internal/admin/*` avatar routes have
 * always had, and the record that makes an unexpected team-logo change attributable.
 */

const ParamsSchema = z.object({ teamId: z.string().trim().min(1).max(200) }).strict();

const ImageQuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1).max(2048).optional(),
    ...AvatarImageQueryFields,
  })
  .strict();

const MutationQuerySchema = z.object({ domain: z.string().trim().min(1) }).strict();

// Keyed per domain + team so one backend churning one team's logo cannot exhaust the budget
// for another team or another domain. Same 30/hour window as every other avatar mutation.
const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const query = MutationQuerySchema.safeParse(request.query);
    const params = ParamsSchema.safeParse(request.params);
    const domain = query.success ? normalizeDomain(query.data.domain) : 'unknown';
    return `domain-team-avatar-write:${domain}:${params.success ? params.data.teamId : 'unknown'}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

export function registerDomainTeamAvatarRoutes(app: FastifyInstance): void {
  app.get(
    '/domain/teams/:teamId/avatar',
    // Auth first, config second: `optionalConfigVerifier` does attacker-directed outbound work, so
    // it must never run for a caller that is about to get a 401. See `optionalConfigVerifier`.
    { preHandler: [requireDomainHashAuthForDomainQuery, optionalConfigVerifier] },
    async (request, reply) => {
      const { teamId } = ParamsSchema.parse(request.params);
      const query = ImageQuerySchema.parse(request.query);
      const domain = normalizeDomain(query.domain);

      const resolvedTeamId = await requireDomainTeamId({ domain, teamId });
      const avatar = await resolveTeamAvatar({
        teamId: resolvedTeamId,
        style: query.style ?? null,
        configDefaultStyle: configDefaultAvatarStyle(request, domain),
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  app.put(
    '/domain/teams/:teamId/avatar',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preHandler: [requireDomainHashAuthForDomainQuery, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { teamId } = ParamsSchema.parse(request.params);
      const { domain } = MutationQuerySchema.parse(request.query);

      const resolvedTeamId = await requireDomainTeamId({ domain, teamId });
      const data = await readAvatarUpload(request);
      const result = await uploadTeamAvatar({ teamId: resolvedTeamId, data });

      await recordDomainAvatarAudit(request, {
        action: 'domain.team_avatar_updated',
        domain,
        metadata: {
          teamId: resolvedTeamId,
          contentType: result.contentType,
          sizeBytes: result.sizeBytes,
        },
      });

      return avatarUploadResponse(result);
    },
  );

  app.delete(
    '/domain/teams/:teamId/avatar',
    {
      preHandler: [requireDomainHashAuthForDomainQuery, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { teamId } = ParamsSchema.parse(request.params);
      const { domain } = MutationQuerySchema.parse(request.query);

      const resolvedTeamId = await requireDomainTeamId({ domain, teamId });
      await deleteTeamAvatar({ teamId: resolvedTeamId });

      await recordDomainAvatarAudit(request, {
        action: 'domain.team_avatar_deleted',
        domain,
        metadata: { teamId: resolvedTeamId },
      });

      return { ok: true };
    },
  );
}

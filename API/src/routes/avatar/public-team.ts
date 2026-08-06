import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { resolveSubjectAvatar } from '../../services/avatar-subject.service.js';
import { resolveTeamAvatar } from '../../services/team-avatar.service.js';
import { AppError } from '../../utils/errors.js';
import { AvatarImageQueryFields, sendAvatar } from './shared.js';

/**
 * Public workspace (team) avatar — the one avatar GET with no credential (Docs/Auth/avatars.md
 * §11.3).
 *
 * Every other avatar route is bearer-gated, which is why §9 excluded the auth-popup chooser
 * payloads from carrying an image URL at all: the popup holds no credential a plain `<img src>`
 * could send, so the chooser could only ever draw an initials badge. This route exists so the
 * chooser can render the workspace's real logo.
 *
 * It is deliberately not an existence oracle. An unknown or deleted `:teamId` renders the same
 * deterministic generated SVG that a real team with no image gets, so every id answers 200 with an
 * image and the response cannot be used to enumerate teams. Team ids are unguessable cuids; what
 * this does expose to anyone holding one is that workspace's logo — the trade the product owner
 * chose over a credentialed chooser fetch.
 *
 * No `config_url` is read here (that would let an anonymous caller aim the config fetcher wherever
 * it liked — see `optionalConfigVerifier`), so the generated style is always the platform default
 * rather than a domain's `avatars.default_style` preference.
 */

const ParamsSchema = z.object({ teamId: z.string().min(1).max(64) }).strict();
const QuerySchema = z.object({ ...AvatarImageQueryFields }).strict();

// The only unauthenticated image endpoint, so it carries its own budget: generous enough for a
// chooser rendering a full workspace list on every login, tight enough that it is not a free
// image-proxy for whoever knows a team id.
const publicAvatarRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => `public:team-avatar:${request.ip ?? 'unknown'}`,
  limit: 300,
  windowMs: 60 * 60 * 1000,
});

export function registerPublicTeamAvatarRoute(app: FastifyInstance): void {
  app.get(
    '/teams/:teamId/avatar',
    { preValidation: [publicAvatarRateLimit] },
    async (request, reply) => {
      const { teamId } = ParamsSchema.parse(request.params);
      const query = QuerySchema.parse(request.query);

      const avatar = await resolveTeamAvatar({
        teamId,
        style: query.style ?? null,
        configDefaultStyle: null,
        size: query.size ?? null,
      }).catch(async (err: unknown) => {
        // Same generated image an existing team with no upload and no icon would serve, so an
        // unknown id is indistinguishable from a real workspace that never set a logo.
        if (err instanceof AppError && err.message === 'TEAM_NOT_FOUND') {
          return await resolveSubjectAvatar(
            { id: teamId, uploaded: null, externalUrl: null },
            { style: query.style ?? null, configDefaultStyle: null, size: query.size ?? null },
          );
        }
        throw err;
      });

      return sendAvatar(request, reply, avatar);
    },
  );
}

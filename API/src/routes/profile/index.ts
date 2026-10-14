import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { readOrUpdateSelfProfile, readOrganisationDisplay, ProfilePatch } from '../../services/profile.service.js';
import { resolveAvatar } from '../../services/avatar.service.js';
import { avatarImageBaseUrl } from '../../utils/avatar-url.js';
import { authorityFor, ProfileQuery } from './authority.js';
import { AppError } from '../../utils/errors.js';

const Target = z.object({ orgId: z.string().min(1).max(256), userId: z.string().min(1).max(256) }).strict();
function imageUrl(request: FastifyRequest, path: string): string {
  const query = ProfileQuery.parse(request.query);
  return `${avatarImageBaseUrl()}${path}?${new URLSearchParams(query)}`;
}
async function noStore(_request: FastifyRequest, reply: FastifyReply) {
  reply.header('Cache-Control', 'private, no-store');
}
const options = { onRequest: noStore, preHandler: [configVerifier, requireDomainHashAuth] };

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get('/profile/me', options, async (request, reply) => {
    const profile = await readOrUpdateSelfProfile(await authorityFor(request), request.adminDb);
    const avatar = imageUrl(request, '/profile/me/avatar');
    return reply.header('Cache-Control', 'private, no-store').send({ ...profile, avatar_url: avatar, avatar_image_url: avatar });
  });
  app.patch('/profile/me', options, async (request, reply) => {
    const patch = ProfilePatch.parse(request.body);
    const profile = await readOrUpdateSelfProfile(await authorityFor(request), request.adminDb, patch);
    const avatar = imageUrl(request, '/profile/me/avatar');
    return reply.header('Cache-Control', 'private, no-store').send({ ...profile, avatar_url: avatar, avatar_image_url: avatar });
  });
  app.get('/profile/me/avatar', options, async (request, reply) => {
    const authority = await authorityFor(request);
    await readOrUpdateSelfProfile(authority, request.adminDb);
    const avatar = await resolveAvatar({ userId: authority.claims.userId }, { prisma: request.adminDb });
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type(avatar.contentType).send(avatar.body);
  });
  const displayPath = '/org/organisations/:orgId/users/:userId/display';
  app.get(displayPath, options, async (request, reply) => {
    const target = Target.parse(request.params);
    const display = await readOrganisationDisplay(await authorityFor(request), target, request.adminDb);
    const { showAvatar, ...record } = { showAvatar: false, ...display };
    const path = `/org/organisations/${encodeURIComponent(target.orgId)}/users/${encodeURIComponent(target.userId)}/display/avatar`;
    return reply.header('Cache-Control', 'private, no-store').send({ ...record,
      ...(showAvatar ? { avatar_image_url: imageUrl(request, path) } : {}) });
  });
  app.get(displayPath + '/avatar', options, async (request, reply) => {
    const target = Target.parse(request.params);
    const display = await readOrganisationDisplay(await authorityFor(request), target, request.adminDb);
    if (!('showAvatar' in display) || !display.showAvatar) throw new AppError('NOT_FOUND', 404);
    const avatar = await resolveAvatar({ userId: target.userId }, { prisma: request.adminDb });
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type(avatar.contentType).send(avatar.body);
  });
}

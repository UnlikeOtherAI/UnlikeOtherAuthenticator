import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../middleware/admin-superuser.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { authorityFor } from '../profile/authority.js';
import { AppError } from '../../utils/errors.js';
import { issueDirectoryCredential, rotateDirectoryCredential, revokeDirectoryCredential,
  listDirectoryCredentials } from '../../services/directory-credential.service.js';
import { listDirectoryGrants, setDirectoryGrant } from '../../services/directory-grant.service.js';
import { readDirectoryStanding, readDirectoryDisplay } from '../../services/directory-read.service.js';
import { resolveAvatar } from '../../services/avatar.service.js';
import { avatarImageBaseUrl } from '../../utils/avatar-url.js';

const id = z.string().min(1).max(256);
const Target = z.object({ orgId: id, userId: id }).strict();
const Grant = z.object({ orgId: id, credentialId: id }).strict();
function admin(request: FastifyRequest) {
  if (!request.adminAccessTokenClaims) throw new AppError('UNAUTHORIZED', 401);
  const { userId, tokenVersion } = request.adminAccessTokenClaims;
  return { userId, tokenVersion };
}
async function noStore(_request: FastifyRequest, reply: FastifyReply) {
  reply.header('Cache-Control', 'private, no-store');
}
const operator = { onRequest: noStore, preHandler: [requireAdminSuperuser] };
const owner = { onRequest: noStore, preHandler: [configVerifier, requireDomainHashAuth] };
const backend = { onRequest: noStore, preHandler: [createRateLimiter({ limit: 1200, windowMs: 60_000,
  keyBuilder: request => `directory:ip:${request.ip}` })] };

export function registerDirectoryRoutes(app: FastifyInstance): void {
  const path = '/internal/admin/directory-credentials';
  app.get(path, operator, async (request, reply) => reply.header('Cache-Control', 'no-store')
    .send(await listDirectoryCredentials(admin(request), request.adminDb)));
  app.post(path, operator, async (request, reply) => {
    const input = z.object({ client_domain_id: id, label: z.string().trim().min(1).max(120), expires_at: z.string().datetime() }).strict().parse(request.body);
    const result = await issueDirectoryCredential({ clientDomainId: input.client_domain_id, label: input.label,
      expiresAt: new Date(input.expires_at), actor: admin(request) }, request.adminDb);
    return reply.header('Cache-Control', 'no-store').status(201).send(result);
  });
  app.post(path + '/:credentialId/rotate', operator, async (request, reply) => {
    const { credentialId } = z.object({ credentialId: id }).strict().parse(request.params);
    const { overlap_seconds } = z.object({ overlap_seconds: z.number().int().min(0).max(600) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await rotateDirectoryCredential({ credentialId, overlapSeconds: overlap_seconds, actor: admin(request) }, request.adminDb));
  });
  app.post(path + '/:credentialId/revoke', operator, async (request, reply) => {
    const { credentialId } = z.object({ credentialId: id }).strict().parse(request.params);
    z.object({}).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await revokeDirectoryCredential({ credentialId, actor: admin(request) }, request.adminDb));
  });
  const grantPath = '/org/organisations/:orgId/product-access';
  app.get(grantPath, owner, async (request, reply) => {
    const { orgId } = z.object({ orgId: id }).strict().parse(request.params);
    return reply.header('Cache-Control', 'private, no-store').send(await listDirectoryGrants(await authorityFor(request), orgId, request.adminDb));
  });
  app.put(grantPath + '/:credentialId', owner, async (request, reply) => {
    const input = Grant.parse(request.params);
    const { permissions } = z.object({ permissions: z.array(z.enum(['MEMBERSHIP_READ', 'DISPLAY_READ', 'WEBHOOK_MANAGE'])).min(1).max(3) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'private, no-store').send(await setDirectoryGrant(await authorityFor(request), { ...input, permissions }, request.adminDb));
  });
  app.delete(grantPath + '/:credentialId', owner, async (request, reply) => {
    const input = Grant.parse(request.params);
    return reply.header('Cache-Control', 'private, no-store').send(await setDirectoryGrant(await authorityFor(request), { ...input, revoke: true }, request.adminDb));
  });
  const subject = '/directory/v1/organisations/:orgId/subjects/:userId';
  app.get(subject + '/standing', backend, async (request, reply) => {
    const input = { ...Target.parse(request.params), authorization: request.headers.authorization };
    return reply.header('Cache-Control', 'private, no-store').send(await readDirectoryStanding(input, request.adminDb));
  });
  app.get(subject + '/display', backend, async (request, reply) => {
    const input = { ...Target.parse(request.params), authorization: request.headers.authorization };
    const display = await readDirectoryDisplay(input, request.adminDb);
    const { showAvatar, ...record } = { showAvatar: false, ...display };
    const image = `${avatarImageBaseUrl()}/directory/v1/organisations/${encodeURIComponent(input.orgId)}/subjects/${encodeURIComponent(input.userId)}/avatar`;
    return reply.header('Cache-Control', 'private, no-store').send({ ...record, ...(showAvatar ? { avatar_image_url: image } : {}) });
  });
  app.get(subject + '/avatar', backend, async (request, reply) => {
    const input = { ...Target.parse(request.params), authorization: request.headers.authorization };
    const display = await readDirectoryDisplay(input, request.adminDb);
    if (!('showAvatar' in display) || !display.showAvatar) throw new AppError('NOT_FOUND', 404);
    const avatar = await resolveAvatar({ userId: input.userId }, { prisma: request.adminDb });
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type(avatar.contentType).send(avatar.body);
  });
}

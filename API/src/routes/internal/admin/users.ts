import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createRateLimiter } from '../../../middleware/rate-limiter.js';
import { writeAuditLog } from '../../../services/audit-log.service.js';
import {
  deleteAvatar,
  requireUserContext,
  resolveAvatar,
  uploadAvatar,
} from '../../../services/avatar.service.js';
import { resetAdminUserTwoFactor } from '../../../services/internal-admin.service.js';
import { AppError } from '../../../utils/errors.js';
import { addAdminUserToTeam } from '../../../services/internal-admin-team-members.service.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  readAvatarUpload,
  sendAvatar,
} from '../../avatar/shared.js';

const UserParamsSchema = z.object({ userId: z.string().trim().min(1) });
const AvatarQuerySchema = z.object({ ...AvatarImageQueryFields }).strict();
const nullableObjectSchema = {
  anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
} as const;
const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

const avatarMutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const params = UserParamsSchema.safeParse(request.params);
    return `admin:user-avatar-write:${params.success ? params.data.userId : 'unknown'}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminUserRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/users/:userId/teams', adminRoute(uploadResponseSchema), async (request) => {
    const { userId } = UserParamsSchema.parse(request.params);
    const body = z.object({
      orgId: z.string().trim().min(1),
      teamId: z.string().trim().min(1),
      teamRole: z.enum(['member', 'admin']),
    }).strict().parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
    return addAdminUserToTeam({
      userId, ...body,
      actor: { via: 'admin_superuser', userId: claims.userId, email: claims.email },
    });
  });

  app.post(
    '/internal/admin/users/:userId/2fa/disable',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { userId } = UserParamsSchema.parse(request.params);
      return resetAdminUserTwoFactor({ userId, actorEmail: requireActorEmail(request) });
    },
  );

  // Image bytes for any user, through the same resolution pipeline as the product-facing routes
  // (Docs/Auth/avatars.md §5). No response schema: this returns an image, not JSON.
  app.get(
    '/internal/admin/users/:userId/avatar',
    { preHandler: [requireAdminSuperuser] },
    async (request, reply) => {
      const { userId } = UserParamsSchema.parse(request.params);
      const query = AvatarQuerySchema.parse(request.query);

      const avatar = await resolveAvatar({
        userId,
        style: query.style ?? null,
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  // Operator-side avatar management, the user mirror of the admin team routes: same body limit,
  // same 1 MiB / magic-byte validation through the shared helpers, and an audit entry against the
  // target user's domain like the other `/internal/admin/*` mutations.
  app.put(
    '/internal/admin/users/:userId/avatar',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preHandler: [requireAdminSuperuser, avatarMutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { userId } = UserParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);

      const context = await requireUserContext(userId);
      const data = await readAvatarUpload(request);
      const result = await uploadAvatar({ userId: context.userId, data });

      await writeAuditLog({
        actorEmail,
        action: 'user.avatar_updated',
        targetDomain: context.domain,
        metadata: {
          userId: context.userId,
          email: context.email,
          contentType: result.contentType,
          sizeBytes: result.sizeBytes,
        },
      });

      return avatarUploadResponse(result);
    },
  );

  app.delete(
    '/internal/admin/users/:userId/avatar',
    {
      preHandler: [requireAdminSuperuser, avatarMutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { userId } = UserParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);

      const context = await requireUserContext(userId);
      await deleteAvatar({ userId: context.userId });

      await writeAuditLog({
        actorEmail,
        action: 'user.avatar_deleted',
        targetDomain: context.domain,
        metadata: { userId: context.userId, email: context.email },
      });

      return { ok: true };
    },
  );
}

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { resetAdminUserTwoFactor } from '../../../services/internal-admin.service.js';
import { AppError } from '../../../utils/errors.js';

const UserParamsSchema = z.object({ userId: z.string().trim().min(1) });
const nullableObjectSchema = {
  anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
} as const;

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
  app.post(
    '/internal/admin/users/:userId/2fa/disable',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { userId } = UserParamsSchema.parse(request.params);
      return resetAdminUserTwoFactor({ userId, actorEmail: requireActorEmail(request) });
    },
  );
}

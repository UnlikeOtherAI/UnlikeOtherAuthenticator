import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { NativeAppIdentifier } from '../../services/oauth/native-app-policy.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

export function registerNativeAppIcon(app: FastifyInstance) {
  app.get('/oauth/apps/:identifier/icon', { preHandler: [requireMcpOAuthPublicProfile] }, async (request, reply) => {
    const { identifier } = z.object({ identifier: NativeAppIdentifier }).parse(request.params);
    const row = await getAdminPrisma().nativeApp.findUnique({ where: { identifier }, select: { enabled: true, iconData: true, iconType: true } });
    if (!row?.enabled || !row.iconData || !row.iconType) throw new AppError('NOT_FOUND', 404);
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'").type(row.iconType).send(Buffer.from(row.iconData));
  });
}

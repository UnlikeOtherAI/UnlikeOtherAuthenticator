import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createRateLimiter } from '../../../middleware/rate-limiter.js';
import { machineBoundary } from '../../../services/machine-authority.service.js';
import { machineRefused } from '../../../services/machine-crypto.js';
import { adminMachineInventory, adminRevokeMachine } from '../../../services/machine-revoke.service.js';

export function registerAdminMachineRoutes(app: FastifyInstance) {
  const limiter = createRateLimiter({ keyBuilder: request => `admin-machines:${request.adminAccessTokenClaims?.userId ?? request.ip}`,
    limit: 60, windowMs: 60000 });
  const options = { preHandler: [requireAdminSuperuser, limiter] };
  app.get('/internal/admin/users/:userId/machines', options, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().min(1).max(100) }).parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    return machineBoundary(() => adminMachineInventory(userId, request.adminDb));
  });
  app.post('/internal/admin/users/:userId/machines/revoke', options, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().min(1).max(100) }).parse(request.params);
    const { enrollment_id } = z.object({ enrollment_id: z.uuid().optional() }).strict().parse(request.body);
    const actor = request.adminAccessTokenClaims ?? machineRefused();
    reply.header('Cache-Control', 'private, no-store');
    return adminRevokeMachine({ subject: userId, enrollmentId: enrollment_id,
      actor: { userId: actor.userId, tokenVersion: actor.tokenVersion } });
  });
}

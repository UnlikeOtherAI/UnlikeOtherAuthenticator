import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  changeFixedSeatCapacity, listSeatSubscriptions,
} from '../../../services/billing-seat-capacity.service.js';
import { AppError } from '../../../utils/errors.js';

const Id = z.string().trim().min(1).max(256);

export function registerInternalAdminBillingSeatCapacityRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/billing/services/:serviceId/seat-subscriptions',
    { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
      const { serviceId } = z.object({ serviceId: Id }).parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return listSeatSubscriptions(serviceId);
    });
  app.post('/internal/admin/billing/seat-subscriptions/:subscriptionId/capacity',
    { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
      const { subscriptionId } = z.object({ subscriptionId: Id }).parse(request.params);
      const { quantity } = z.object({ quantity: z.number().int().positive() }).strict()
        .parse(request.body);
      const claims = request.adminAccessTokenClaims;
      if (!claims) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
      const revision = await changeFixedSeatCapacity({ subscriptionId, quantity,
        actor: { userId: claims.userId, tokenVersion: claims.tokenVersion } });
      reply.header('Cache-Control', 'private, no-store');
      return revision;
    });
}

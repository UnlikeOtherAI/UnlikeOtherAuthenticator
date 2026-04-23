import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  grantAdminSuperuser,
  listAdminSuperusers,
  revokeAdminSuperuser,
  searchNonSuperusers,
} from '../../../services/admin-superusers.service.js';
import { AppError } from '../../../utils/errors.js';

const UserIdParamsSchema = z.object({ userId: z.string().min(1) });
const GrantBodySchema = z.object({ userId: z.string().min(1) }).strict();
const SearchQuerySchema = z.object({ q: z.string().optional().default('') });
const arraySchema = { type: 'array', items: { type: 'object', additionalProperties: true } } as const;
const objectSchema = { type: 'object', additionalProperties: true } as const;

const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
};

export function registerInternalAdminSuperuserRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/superusers',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async () => listAdminSuperusers(),
  );

  app.get(
    '/internal/admin/superusers/search',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async (request) => {
      const { q } = SearchQuerySchema.parse(request.query);
      return searchNonSuperusers(q);
    },
  );

  app.post(
    '/internal/admin/superusers',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const body = GrantBodySchema.parse(request.body);
      return reply.status(201).send(await grantAdminSuperuser(body.userId));
    },
  );

  app.delete('/internal/admin/superusers/:userId', adminRoute, async (request, reply) => {
    const { userId } = UserIdParamsSchema.parse(request.params);
    const actorUserId = request.adminAccessTokenClaims?.userId;
    if (!actorUserId) throw new AppError('UNAUTHORIZED', 401);
    await revokeAdminSuperuser({ userId, actorUserId });
    return reply.status(204).send();
  });
}

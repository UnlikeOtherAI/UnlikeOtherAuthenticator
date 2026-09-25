import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../utils/errors.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { listNativeApps, saveNativeApp, setNativeAppIcon } from '../../../services/oauth/native-app.service.js';

const Id = z.object({ id: z.string().min(1).max(128) });
export function registerInternalAdminNativeApps(app: FastifyInstance) {
  const options = { preHandler: [requireAdminSuperuser] };
  app.get('/internal/admin/native-apps', options, listNativeApps);
  app.post('/internal/admin/native-apps', options, async (request, reply) => {
    const result = await saveNativeApp(request.body, request.adminAccessTokenClaims?.email ?? missingActor());
    return reply.code(201).send(result);
  });
  app.put('/internal/admin/native-apps/:id', options, async (request) =>
    saveNativeApp(request.body, request.adminAccessTokenClaims?.email ?? missingActor(), Id.parse(request.params).id));
  app.put('/internal/admin/native-apps/:id/icon', { ...options, bodyLimit: 360 * 1024 }, async (request) => {
    const { image } = z.object({ image: z.string().max(350 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/).nullable() }).strict().parse(request.body);
    return setNativeAppIcon(Id.parse(request.params).id, image ? Buffer.from(image, 'base64') : null, request.adminAccessTokenClaims?.email ?? missingActor());
  });
}

function missingActor(): never { throw new AppError('UNAUTHORIZED', 401); }

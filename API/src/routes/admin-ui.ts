import type { FastifyInstance } from 'fastify';

import {
  isAdminStaticAssetPath,
  readAdminIndexHtml,
  readAdminUiAsset,
} from '../services/admin-ui.service.js';

export function registerAdminUiRoutes(app: FastifyInstance): void {
  app.get('/admin', async (_request, reply) => {
    reply.redirect('/admin/', 302);
  });

  app.get('/admin/assets/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const rel = params['*'] ?? '';
    const { body, contentType } = await readAdminUiAsset({
      relativePath: `assets/${rel}`,
    });
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type(contentType).status(200).send(body);
  });

  app.get('/admin/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const rel = params['*'] ?? '';

    if (isAdminStaticAssetPath(rel)) {
      const { body, contentType } = await readAdminUiAsset({ relativePath: rel });
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.type(contentType).status(200).send(body);
      return;
    }

    const html = await readAdminIndexHtml();
    reply.header('Cache-Control', 'no-store, no-cache');
    reply.header('Pragma', 'no-cache');
    reply.type('text/html; charset=utf-8').status(200).send(html);
  });
}

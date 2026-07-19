import type { FastifyInstance } from 'fastify';

import { isTariffSnapshotJwksEnabled } from '../../config/env.js';
import { getTariffSnapshotPublicJwks } from '../../services/billing-snapshot.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

export function registerBillingJwksRoute(app: FastifyInstance): void {
  app.get('/billing/v1/jwks.json', async (_request, reply) => {
    if (!isTariffSnapshotJwksEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const jwks = await getTariffSnapshotPublicJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send(jwks);
  });
}

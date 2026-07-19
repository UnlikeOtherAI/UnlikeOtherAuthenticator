import type { FastifyInstance } from 'fastify';

import { isBillingAssertionJwksEnabled } from '../../config/env.js';
import { getBillingAssertionPublicJwks } from '../../services/billing-ledger-collector.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

export function registerBillingServiceJwksRoute(app: FastifyInstance): void {
  app.get('/billing/v1/service-jwks.json', async (_request, reply) => {
    if (!isBillingAssertionJwksEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const jwks = await getBillingAssertionPublicJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send(jwks);
  });
}

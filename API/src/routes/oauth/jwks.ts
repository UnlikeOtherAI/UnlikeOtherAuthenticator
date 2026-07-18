import type { FastifyInstance } from 'fastify';

import { isOAuthAccessTokenJwksEnabled } from '../../config/env.js';
import { getAccessTokenPublicJwks } from '../../services/oauth/access-token.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// Public JWKS for confidential and optional public-profile RS256 access tokens
// (brief §22.14-§22.15). Distinct from the config-signing JWKS at
// /.well-known/jwks.json (§22.2) — do not conflate the two.
export function registerOAuthJwksRoute(app: FastifyInstance): void {
  app.get('/oauth/jwks.json', async (_request, reply) => {
    if (!isOAuthAccessTokenJwksEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const jwks = await getAccessTokenPublicJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send(jwks);
  });
}

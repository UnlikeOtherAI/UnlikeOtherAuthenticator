import type { FastifyInstance } from 'fastify';

import { isMcpOAuthEnabled } from '../../config/env.js';
import { getAccessTokenPublicJwks } from '../../services/oauth/access-token.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// Public JWKS for the MCP profile's RS256 access tokens (brief §22.14). Resource
// servers verify access tokens with these keys. Distinct from the config-signing
// JWKS at /.well-known/jwks.json (§22.2) — do not conflate the two.
export function registerOAuthJwksRoute(app: FastifyInstance): void {
  app.get('/oauth/jwks.json', async (_request, reply) => {
    if (!isMcpOAuthEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const jwks = await getAccessTokenPublicJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send(jwks);
  });
}

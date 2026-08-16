import type { FastifyInstance } from 'fastify';

import { isOAuthAccessTokenJwksEnabled, isUserAccessTokenRs256Enabled } from '../../config/env.js';
import { getAccessTokenPublicJwks } from '../../services/oauth/access-token.service.js';
import { getUserAccessTokenPublicJwks } from '../../services/user-access-token-key.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// Public JWKS for the RS256 tokens UOA issues: confidential resource tokens and
// optional public-profile tokens (brief §22.14-§22.15), plus the user access
// token once this deployment signs it RS256. Each class pins its own `typ` and
// `aud` at verification, and `kid` separates the keys, so publishing them in one
// set cannot let a token of one class be accepted as another.
//
// Distinct from the config-signing JWKS at /.well-known/jwks.json (§22.2) — those
// are keys UOA *verifies* clients with, not keys it signs with. Do not conflate.
export function registerOAuthJwksRoute(app: FastifyInstance): void {
  app.get('/oauth/jwks.json', async (_request, reply) => {
    const resourceTokens = isOAuthAccessTokenJwksEnabled();
    const userAccessTokens = isUserAccessTokenRs256Enabled();
    if (!resourceTokens && !userAccessTokens) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const sets = await Promise.all([
      resourceTokens ? getAccessTokenPublicJwks() : Promise.resolve({ keys: [] }),
      userAccessTokens ? getUserAccessTokenPublicJwks() : Promise.resolve({ keys: [] }),
    ]);
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send({ keys: sets.flatMap((set) => set.keys) });
  });
}

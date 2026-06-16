import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { isMcpOAuthEnabled } from '../../config/env.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { buildMcpClientConfig } from '../../services/oauth/config.service.js';
import { getOAuthClient } from '../../services/oauth/client.service.js';
import { exchangeOAuthCodeForAccessToken } from '../../services/oauth/token-exchange.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// Public PKCE token endpoint for the MCP profile (brief §22.14). No client secret /
// domain-hash: the registered public client + the PKCE verifier authenticate the
// exchange. Returns a resource-bound RS256 access token.
const BodySchema = z
  .object({
    grant_type: z.literal('authorization_code').optional(),
    code: z.string().min(1).max(512),
    redirect_uri: z.string().min(1).max(2048),
    code_verifier: z.string().min(1).max(256).optional(),
    client_id: z.string().min(1).max(256),
    scope: z.string().max(512).optional(),
  })
  .strip();

export function registerOAuthTokenRoute(app: FastifyInstance): void {
  const limiter = createRateLimiter({
    limit: 30,
    windowMs: 5 * 60 * 1000,
    keyBuilder: (request) => `oauth-token:ip:${request.ip || 'unknown'}`,
  });

  app.post('/oauth/token', { preHandler: [limiter] }, async (request, reply) => {
    if (!isMcpOAuthEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const body = BodySchema.parse(request.body ?? {});

    const client = await getOAuthClient(body.client_id);
    if (!client || !client.redirectUris.includes(body.redirect_uri)) {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }

    const config = buildMcpClientConfig(client.redirectUris);
    request.tenantContext = { domain: config.domain, orgId: null, userId: null };

    const result = await request.withTenantTx(async (tx) =>
      exchangeOAuthCodeForAccessToken(
        {
          code: body.code,
          clientId: client.clientId,
          redirectUrl: body.redirect_uri,
          codeVerifier: body.code_verifier,
          domain: config.domain,
          scope: body.scope,
        },
        asPrismaClient(tx),
        request.adminDb,
      ),
    );

    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.status(200).send({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresInSeconds,
    });
  });
}

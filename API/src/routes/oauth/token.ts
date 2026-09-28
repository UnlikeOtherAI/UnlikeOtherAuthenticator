import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { buildMcpClientConfig } from '../../services/oauth/config.service.js';
import { getOAuthClient } from '../../services/oauth/client.service.js';
import { exchangeNativeRefreshToken } from '../../services/oauth/native-refresh.service.js';
import { exchangeOAuthCodeForAccessToken } from '../../services/oauth/token-exchange.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

// Public PKCE token endpoint for the MCP profile (brief §22.14). No client secret /
// domain-hash: the registered public client + the PKCE verifier authenticate the
// exchange. Returns a resource-bound RS256 access token; registered native-app
// clients also receive, and later rotate, an opaque refresh token.
const AuthorizationCodeBodySchema = z
  .object({
    grant_type: z.literal('authorization_code').optional(),
    code: z.string().min(1).max(512),
    redirect_uri: z.string().min(1).max(2048),
    code_verifier: z.string().min(1).max(256).optional(),
    client_id: z.string().min(1).max(256),
    scope: z.string().max(512).optional(),
  })
  .strip();

const RefreshTokenBodySchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(4096),
    client_id: z.string().min(1).max(256),
    scope: z.string().max(512).optional(),
  })
  .strip();

function isRefreshGrant(request: FastifyRequest): boolean {
  const body = request.body as { grant_type?: unknown } | null | undefined;
  return body?.grant_type === 'refresh_token';
}

function sendTokenResponse(reply: FastifyReply, body: Record<string, unknown>): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.status(200).send(body);
}

async function handleRefreshGrant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = RefreshTokenBodySchema.parse(request.body);
  const result = await exchangeNativeRefreshToken(
    { refreshToken: body.refresh_token, clientId: body.client_id, scope: body.scope },
    request.adminDb,
  );
  sendTokenResponse(reply, {
    access_token: result.accessToken,
    token_type: 'Bearer',
    expires_in: result.expiresInSeconds,
    refresh_token: result.refreshToken,
    refresh_token_expires_in: result.refreshTokenExpiresInSeconds,
    ...(result.scope ? { scope: result.scope } : {}),
  });
}

async function handleAuthorizationCodeGrant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = AuthorizationCodeBodySchema.parse(request.body ?? {});

  const client = await getOAuthClient(body.client_id);
  if (!client || !client.redirectUris.includes(body.redirect_uri)) {
    reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
    return;
  }

  const config = buildMcpClientConfig(client.redirectUris, client.nativeApp);
  request.tenantContext = { domain: config.domain, orgId: null, userId: null };

  const result = await request.adminDb.$transaction(async (tx) =>
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

  sendTokenResponse(reply, {
    access_token: result.accessToken,
    token_type: 'Bearer',
    expires_in: result.expiresInSeconds,
    ...(result.refreshToken
      ? {
          refresh_token: result.refreshToken,
          refresh_token_expires_in: result.refreshTokenExpiresInSeconds,
        }
      : {}),
  });
}

export function registerOAuthTokenRoute(app: FastifyInstance): void {
  // Separate IP buckets: a burst of interactive code exchanges cannot starve the silent
  // refreshes that restore native sessions at launch, and vice versa.
  const codeLimiter = createRateLimiter({
    limit: 30,
    windowMs: 5 * 60 * 1000,
    keyBuilder: (request) => `oauth-token:ip:${request.ip || 'unknown'}`,
  });
  const refreshLimiter = createRateLimiter({
    limit: 60,
    windowMs: 5 * 60 * 1000,
    keyBuilder: (request) => `oauth-token-refresh:ip:${request.ip || 'unknown'}`,
  });

  app.post(
    '/oauth/token',
    {
      preHandler: [
        requireMcpOAuthPublicProfile,
        async (request) =>
          isRefreshGrant(request) ? refreshLimiter(request) : codeLimiter(request),
      ],
    },
    async (request, reply) =>
      isRefreshGrant(request)
        ? handleRefreshGrant(request, reply)
        : handleAuthorizationCodeGrant(request, reply),
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { registerOAuthClient } from '../../services/oauth/client.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

// RFC 7591 Dynamic Client Registration for public MCP clients (brief §22.14).
// PUBLIC clients only: no client_secret is issued. IP-rate-limited to bound abuse
// (each call writes a row).
const RegisterBodySchema = z
  .object({
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    client_name: z.string().min(1).max(200).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().max(512).optional(),
  })
  .strip();

export function registerOAuthRegisterRoute(app: FastifyInstance): void {
  const limiter = createRateLimiter({
    limit: 20,
    windowMs: 60 * 60 * 1000,
    keyBuilder: (request) => `oauth-register:ip:${request.ip || 'unknown'}`,
  });

  app.post(
    '/oauth/register',
    { preHandler: [requireMcpOAuthPublicProfile, limiter] },
    async (request, reply) => {
      const body = RegisterBodySchema.parse(request.body ?? {});
      // We only support public clients; reject a confidential auth method explicitly.
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
        reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
        return;
      }

      const scopes = body.scope
        ? body.scope
            .split(' ')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const client = await registerOAuthClient({
        redirectUris: body.redirect_uris,
        clientName: body.client_name,
        scopes,
      });

      reply.header('Cache-Control', 'no-store');
      reply.status(201).send({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName ?? undefined,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: client.scopes.join(' ') || undefined,
      });
    },
  );
}

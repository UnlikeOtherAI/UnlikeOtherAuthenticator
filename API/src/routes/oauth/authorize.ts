import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isMcpOAuthEnabled } from '../../config/env.js';
import { getOAuthClient } from '../../services/oauth/client.service.js';
import { buildMcpClientConfig } from '../../services/oauth/config.service.js';
import { validateRequestedResource } from '../../services/oauth/resource-validation.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// Public-client authorization endpoint for the MCP profile (brief §22.14). Validates
// the registered client + redirect_uri + PKCE, then renders the first-party login UI
// with a synthesized config (no client config_url). The login screen posts to
// /oauth/login, which issues the code and redirects to redirect_uri?code=&state=.
const QuerySchema = z
  .object({
    response_type: z.string().optional(),
    client_id: z.string().min(1).max(256),
    redirect_uri: z.string().min(1).max(2048),
    code_challenge: z.string().min(1).max(256),
    code_challenge_method: z.string().min(1).max(32),
    state: z.string().max(2048).optional(),
    scope: z.string().max(512).optional(),
    resource: z.string().max(2048).optional(),
  })
  .strip();

export function registerOAuthAuthorizeRoute(app: FastifyInstance): void {
  app.get('/oauth/authorize', async (request, reply) => {
    if (!isMcpOAuthEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }
    const q = parsed.data;
    if (q.response_type && q.response_type !== 'code') {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }
    if (q.code_challenge_method !== 'S256') {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }

    const client = await getOAuthClient(q.client_id);
    if (!client || !client.redirectUris.includes(q.redirect_uri)) {
      // Per OAuth, never redirect to an unvalidated redirect_uri — surface a 400.
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }

    // RFC 8707: reject an out-of-allowlist `resource` early (invalid_target), before
    // rendering the login UI, so the client fails fast instead of at /oauth/login.
    try {
      validateRequestedResource(q.resource);
    } catch {
      reply.status(400).send(buildPublicErrorBody({ statusCode: 400 }));
      return;
    }

    const config = buildMcpClientConfig(client.redirectUris);
    const html = await renderAuthEntrypointHtml({
      config,
      // Sentinel in place of a client config_url; the UI's MCP mode keys off the
      // client_id present in the initial search and posts to /oauth/login.
      configUrl: 'urn:uoa:mcp',
      requestUrl: request.raw.url ?? '',
    });
    sendAuthHtml(reply, html);
  });
}

import type { FastifyInstance } from 'fastify';

import { getEnv, getMcpOAuthResources, getPublicBaseUrl, isMcpOAuthEnabled } from '../../config/env.js';
import { buildPublicErrorBody } from '../../utils/error-response.js';

// RFC 8414 Authorization Server Metadata for the public-client / MCP profile
// (brief §22.14). Advertises only the /oauth/* public-client surface; the existing
// config-JWT /auth/* flow is intentionally not described here.
export function registerOAuthMetadataRoute(app: FastifyInstance): void {
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    if (!isMcpOAuthEnabled()) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }
    const issuer = getPublicBaseUrl();
    const scopes = (getEnv().MCP_OAUTH_SCOPES_SUPPORTED ?? 'openid')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const resources = getMcpOAuthResources();

    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8').send({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      jwks_uri: `${issuer}/oauth/jwks.json`,
      scopes_supported: scopes,
      response_types_supported: ['code'],
      // Only advertise grants that are implemented. refresh_token for this profile
      // is a follow-up; access tokens are short-lived and clients re-authorize.
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      // RFC 8707: this profile binds tokens to the requested resource (the `aud`).
      authorization_response_iss_parameter_supported: false,
      // RFC 8707: only advertise resource-indicator support when an allowlist is
      // configured, and constrain it to the allowed resources. Never advertise
      // unconstrained support.
      ...(resources.length > 0
        ? { resource_indicators_supported: true, resources_supported: resources }
        : {}),
    });
  });
}

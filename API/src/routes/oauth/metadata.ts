import type { FastifyInstance } from 'fastify';

import { getMcpOAuthResources, getPublicBaseUrl } from '../../config/env.js';
import { publicOAuthScopes } from '../../services/oauth/scopes.service.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

// RFC 8414 Authorization Server Metadata for the public-client / MCP profile
// (brief §22.14). Advertises only the /oauth/* public-client surface; the existing
// config-JWT /auth/* flow is intentionally not described here.
export function registerOAuthMetadataRoute(app: FastifyInstance): void {
  app.get(
    '/.well-known/oauth-authorization-server',
    { preHandler: [requireMcpOAuthPublicProfile] },
    async (_request, reply) => {
      const issuer = getPublicBaseUrl();
      const scopes = publicOAuthScopes();
      const resources = getMcpOAuthResources();

      reply.header('Cache-Control', 'public, max-age=300');
      reply.type('application/json; charset=utf-8').send({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        jwks_uri: `${issuer}/oauth/jwks.json`,
        scopes_supported: scopes,
        response_types_supported: ['code'],
        // Only advertise grants that are implemented. refresh_token is issued only to
        // clients registered with an enabled native-app app_id (see /oauth/register's
        // per-client grant_types); plain dynamic registrations re-authorize on expiry.
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        // RFC 8707: this profile binds tokens to the requested resource (the `aud`).
        authorization_response_iss_parameter_supported: false,
        // RFC 8707: only advertise resource-indicator support when an allowlist is
        // configured, and constrain it to the allowed resources. Never advertise
        // unconstrained support.
        ...(resources.length > 0
          ? { resource_indicators_supported: true, resources_supported: resources }
          : {}),
      });
    },
  );
}

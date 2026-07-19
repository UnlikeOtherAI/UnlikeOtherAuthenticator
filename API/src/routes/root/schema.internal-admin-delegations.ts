import type { EndpointSchema } from './schema.js';

export function buildInternalAdminConfidentialDelegationEndpoints(params: {
  adminAuth: string;
  authFailures: string;
}): EndpointSchema[] {
  const mappingResponse =
    '{ id, source_domain, product, resource, scopes, enabled, created_by_email, updated_by_email, created_at, updated_at }; never contains a client secret, domain hash, digest, or credential id';

  return [
    {
      method: 'GET',
      path: '/internal/admin/confidential-delegations',
      description: 'List the DB-backed per-product confidential token-exchange allowlist',
      auth: params.adminAuth,
      response: {
        200: `Array of ${mappingResponse}`,
        '401/403': params.authFailures,
      },
    },
    {
      method: 'POST',
      path: '/internal/admin/confidential-delegations',
      description:
        'Bind one registered source domain/product to one exact HTTPS resource and scope allowlist. The source app continues to authenticate with its own rotatable domain credential.',
      auth: params.adminAuth,
      body: {
        source_domain:
          'string (required) — exact active ClientDomain whose existing domain credential authenticates this product',
        product: 'lowercase identifier (required, [a-z0-9][a-z0-9._-]{0,99})',
        resource: 'exact HTTPS resource URI (required; userinfo and fragments forbidden)',
        scopes:
          'non-empty unique array containing only "ai.invoke", "billing.read", and/or "token.provision"; token provisioning is never implied by an AI grant',
        enabled: 'boolean (optional; defaults true)',
      },
      response: {
        201: mappingResponse,
        '401/403': params.authFailures,
      },
    },
    {
      method: 'PATCH',
      path: '/internal/admin/confidential-delegations/:mappingId',
      description:
        'Change the exact resource, scope allowlist, or enabled state. Source domain and product are immutable; replace the mapping to rebind them.',
      auth: params.adminAuth,
      body: {
        resource: 'exact HTTPS resource URI (optional)',
        scopes:
          'non-empty unique array containing only "ai.invoke", "billing.read", and/or "token.provision" (optional)',
        enabled: 'boolean (optional)',
      },
      response: {
        200: mappingResponse,
        '401/403': params.authFailures,
      },
    },
    {
      method: 'DELETE',
      path: '/internal/admin/confidential-delegations/:mappingId',
      description: 'Delete a product delegation mapping; subsequent exchanges fail closed',
      auth: params.adminAuth,
      response: {
        204: 'No content',
        '401/403': params.authFailures,
      },
    },
  ];
}

import type { EndpointSchema } from './schema.js';

export function adminUserCreationEndpoint(adminAuth: string, authFailures: string): EndpointSchema {
  return {
    method: 'POST',
    path: '/internal/admin/users',
    description: 'Create a global email/password identity with an optional account expiry; admin superuser only',
    auth: adminAuth,
    body: {
      email: 'email', password: 'string, 8-1024 characters', name: 'string (optional, max 200)',
      accountExpiresAt: 'ISO 8601 date-time with offset (optional, must be future)',
    },
    response: { 200: 'Admin user summary without password', '401/403': authFailures,
      409: 'Global email identity already exists' },
  };
}

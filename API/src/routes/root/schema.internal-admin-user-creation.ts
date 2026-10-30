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

export function adminUserRenewalEndpoints(adminAuth: string, authFailures: string): EndpointSchema[] {
  return [
    { method: 'PATCH', path: '/internal/admin/users/:userId/expiry',
      description: 'Set or remove the account expiry; superuser only', auth: adminAuth,
      body: { accountExpiresAt: 'future ISO 8601 date-time with offset or null' },
      response: { 200: '{ accountExpiresAt }', '401/403': authFailures } },
    { method: 'POST', path: '/internal/admin/account-renewal-requests/:requestId/review',
      description: 'Approve a pending expired-account request with a new expiry or decline it; superuser only', auth: adminAuth,
      body: { decision: 'approve | decline', accountExpiresAt: 'future ISO 8601 date-time with offset when approving' },
      response: { 200: '{ userId, status, accountExpiresAt }', 409: 'Request is no longer pending', '401/403': authFailures } },
  ];
}

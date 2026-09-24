import type { EndpointSchema } from './schema.js';

const shared = {
  method: 'POST',
  auth: 'Domain hash bearer + verified config_url + exactly one user access token or RS256 X-UOA-Subject-Assertion (audience /org). No backend-only mode.',
  query: { domain: 'string (required)', config_url: 'HTTPS signed config URL (required)' },
  notes: 'Server-to-server only. Never expose domain credentials to a browser. A session identifies the person; it does not satisfy fresh verification.',
};
export const actionVerificationEndpoints: EndpointSchema[] = [
  {
    ...shared, path: '/auth/action-verification/start',
    description: 'Email a fresh single-use code for an exact product action. 20 requests per person per 15 minutes.',
    body: { actionDigest: '64 lowercase hex SHA-256 binding to person, action nonce and immutable terms',
      description: 'string (required, 1–240 chars), human-readable action for the email' },
    response: { challengeId: 'UUID', expiresAt: 'ISO timestamp, five minutes', twoFactorRequired: 'boolean' },
  },
  {
    ...shared, path: '/auth/action-verification/verify',
    description: 'Verify and consume the exact challenge. Five guesses, actor/domain/action/credential-epoch bound; replay is rejected.',
    body: { actionDigest: 'same exact digest', challengeId: 'UUID', code: 'six-digit email code',
      twoFactorCode: 'six-digit fresh authenticator code, required for enrolled accounts' },
    response: { verified: 'true', actionDigest: 'verified action binding' },
  },
];

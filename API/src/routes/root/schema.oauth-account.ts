import type { EndpointSchema } from './schema.js';
const auth = 'Public OAuth RS256 bearer token, issuer audience, token_use=public_oauth, current credential epoch; public profile must be enabled';
export const oauthAccountEndpoints: EndpointSchema[] = [
  { method: 'GET', path: '/oauth/me', description: 'Current UOA subject, email and name. Profile scope required.', auth,
    response: { sub: 'string', email: 'string', name: 'string | null' } },
  { method: 'GET', path: '/oauth/me/avatar', description: 'Current subject avatar, resolved by UOA. Profile scope required.', auth,
    response: { 200: 'image bytes; no-store' } },
  { method: 'GET', path: '/oauth/me/settings/:namespace/:key', description: 'Read an opaque personal setting. settings.read scope required.', auth,
    response: { value: 'JSON value or null when absent', ETag: 'response header; opaque version for conditional writes' } },
  { method: 'PUT', path: '/oauth/me/settings/:namespace/:key', description: 'Replace or delete one personal setting. settings.write scope required.', auth,
    body: { value: 'JSON value; null deletes' }, response: { value: 'saved JSON value or null' },
    notes: 'Requires If-Match with the ETag from GET. Missing/invalid precondition: 428; stale value: 409. Same store and quotas as /settings/me. Never supply a user id. No-store responses.' },
];

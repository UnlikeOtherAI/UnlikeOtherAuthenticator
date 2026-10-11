import type { EndpointSchema } from './schema.js';
const auth = 'Public OAuth RS256 bearer token, issuer audience, token_use=public_oauth, current credential epoch; public profile must be enabled';
export const oauthAccountEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/oauth/kelpie/connect', description: 'Issue a profile-free Nessie connection ticket for the current Kelpie native account.', auth,
    body: { resource: 'exact operator KELPIE_CONNECT_RESOURCE HTTPS URL' },
    response: { connection_ticket: 'RS256 at+jwt, token_use=kelpie_connect; no profile or org', token_type: 'Bearer', expires_in: 'seconds, at most 120 and capped by account expiry', gateway_url: 'corresponding WSS URL' },
    notes: 'Requires kelpie.connect scope and current enabled com.unlikeotherai.kelpie registration. No-store, including errors. Generic 401 invalid authority, 403 missing scope, 404 disabled, 400 invalid body/resource. Native keeps UOA account bearer local.' },
  { method: 'POST', path: '/oauth/kelpie/connect/validate', description: 'Live UOA authority validation for the configured Nessie gateway.',
    auth: 'current domain hash bearer for the exact configured resource host', query: { domain: 'exact KELPIE_CONNECT_RESOURCE host' }, body: { ticket: 'Kelpie connection ticket' },
    response: { active: 'true', iss: 'UOA issuer', sub: 'stable UOA subject', aud: 'exact gateway resource', client_id: 'native public client', app_id: 'com.unlikeotherai.kelpie', exp: 'ticket expiry seconds', jti: 'ticket id' },
    notes: 'No profile or memberships. Rechecks signature, token class/audience/expiry, current registered app/client revision, server/client scopes, ACTIVE subject, credential epoch, factor, bans, login and signature policies and domain credential. Generic 401 invalid authority. Gateway revalidates at most every 30 seconds and before dispatch, closes on failure, reauthenticates before expiry. No-store, including errors.' },
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

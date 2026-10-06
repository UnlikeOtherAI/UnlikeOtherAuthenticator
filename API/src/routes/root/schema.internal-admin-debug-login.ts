import type { EndpointSchema } from './schema.js';
const query = { config_url: 'exact canonical first-party /internal/admin/config URL' };
const boundary = 'Exact service Origin and JSON POST required before config lookup. Current ACTIVE user, credential epoch, SUPERUSER admin-domain role and valid source family; secret domain credentials never accepted.';
export const internalAdminDebugLoginEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/internal/admin/debug-login/issue', description: 'Create or renew a single-use admin debug login',
    auth: 'Current admin bearer and exact bearer-associated HttpOnly source cookie', query,
    body: { previous_token: 'optional previous one-use code to invalidate' },
    response: { 200: '{url,token,expires_in}', '401/403': 'Authentication failed', 429: 'Rate limited' },
    notes: `${boundary} At most 1800 seconds, capped by source session expiry. Clipboard JSON is exactly {url,token}.` },
  { method: 'POST', path: '/internal/admin/debug-login/redeem', description: 'Consume an admin debug code into an independent recipient family',
    auth: 'One-use admin code; exact same-origin JSON POST', query, body: { token: 'opaque one-use code' },
    response: { 200: '{access_token,expires_in,token_type:"Bearer"}; private Set-Cookie ownership handle', 401: 'Authentication failed' },
    notes: `${boundary} Atomic single use; fresh short-lived admin bearer and independent private family. No refresh credential in JSON.` },
  { method: 'POST', path: '/internal/admin/logout', description: 'Revoke only the exact bearer-associated admin source family',
    auth: 'Current admin bearer; exact same-origin JSON POST', query, body: {}, response: { 200: '{ok:true}' },
    notes: 'Clears its private cookie and invalidates unused source debug codes. Independent recipient/source sessions remain active.' },
];

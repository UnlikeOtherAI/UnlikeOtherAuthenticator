import type { EndpointSchema } from './schema.js';
import { oauthAccountEndpoints } from './schema.oauth-account.js';
const auth = 'UOA RS256 embedded_kelpie_account bearer, exact embedded audience and live original independent host-session proof; no refresh credential';
export const embeddedKelpieEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/org/me/kelpie/session', description: 'Derive a short-lived Kelpie browser grant from the gateway product\'s original UOA session.',
    auth: 'current source domain bearer + verified config + X-UOA-Subject-Assertion or X-UOA-Access-Token; original independent proof mandatory',
    query: { domain: 'exact KELPIE_CONNECT_RESOURCE host', config_url: 'signed source product config URL' }, body: {},
    response: { access_token: 'RS256 at+jwt embedded_kelpie_account; exact <issuer>/embedded/kelpie audience', token_type: 'Bearer',
      expires_in: 'at most 120 seconds and capped by original proof expiry', sub: 'stable UOA subject', issuer: 'UOA issuer origin' },
    notes: 'Empty JSON body. Fixed profile/email/settings.read/settings.write/kelpie.connect scope. No native registration, refresh family, profile copy or consent widening. Original proof, epoch, current domain/subject/memberships and policy are rechecked. Private/no-store, including errors.' },
  ...oauthAccountEndpoints.filter(endpoint => endpoint.path.startsWith('/oauth/me')).map(endpoint => ({
    ...endpoint, path: endpoint.path.replace('/oauth', '/embedded/kelpie').replace('/:namespace/:key', '/browser/bookmarks'), auth,
    description: endpoint.path.includes('/settings/') ? `Browser bookmarks only. ${endpoint.description}` : endpoint.description,
    notes: 'Same profile, avatar, conditional settings and version1 stream implementation as public native clients, with live original host authority. All other settings namespaces/keys are refused. Streams share admission limits. Expiry requires a fresh host grant. Private/no-store; no credentials in URLs.',
  })),
  { method: 'POST', path: '/embedded/kelpie/connect', description: 'Issue an original-host-bound agent connection ticket.', auth,
    body: { resource: 'exact operator KELPIE_CONNECT_RESOURCE' },
    response: { connection_ticket: 'RS256 embedded_kelpie_connect, exact resource audience', token_type: 'Bearer',
      expires_in: 'seconds capped by account grant and original proof', gateway_url: 'corresponding WSS URL' } },
  { method: 'POST', path: '/embedded/kelpie/connect/validate', description: 'Strict combined live gateway validator for native and embedded tickets.',
    auth: 'current domain bearer for exact configured resource host', query: { domain: 'gateway resource host' },
    body: { ticket: 'native or embedded connection ticket; no account or pairing token' },
    response: { active: 'true', source: 'native | embedded', iss: 'UOA issuer', sub: 'stable UOA subject', aud: 'gateway resource',
      client_id: 'native public client id or embedded:<ClientDomain id>', app_id: 'com.unlikeotherai.kelpie or embedded:<source domain>',
      exp: 'expiry seconds', jti: 'ticket id' },
    notes: 'Each class retains its own signature, audience, lifetime and live authority checks. Native still requires public profile and consent. Embedded requires original host proof and enabled source. Generic errors; private/no-store. Revalidate on admission, before dispatch and at most every 30seconds; close on failure or expiry.' },
];

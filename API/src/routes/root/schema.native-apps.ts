import type { EndpointSchema } from './schema.js';
export const nativeAppEndpoints: EndpointSchema[] = [
  { method: 'GET', path: '/internal/admin/native-apps', auth: 'Admin superuser bearer',
    description: 'List operator-owned public native app profiles', response: { items: 'Array of app profiles; no credentials' } },
  { method: 'POST', path: '/internal/admin/native-apps', auth: 'Admin superuser bearer',
    description: 'Register a native app; immutable reverse-domain identifier', body: {
      identifier: 'reverse-domain string', name: 'string', enabled: 'boolean', redirect_uris: 'string[]', scopes: 'account scope[]',
      methods: '[google and/or email_password]', allow_registration: 'boolean', primary_color: '#RRGGBB', background_color: '#RRGGBB', text_color: '#RRGGBB',
    } },
  { method: 'PUT', path: '/internal/admin/native-apps/:id', auth: 'Admin superuser bearer',
    description: 'Replace mutable profile fields; security edits invalidate existing registrations. Identifier cannot change.' },
  { method: 'PUT', path: '/internal/admin/native-apps/:id/icon', auth: 'Admin superuser bearer',
    description: 'Upload a bounded raster icon or remove it', body: { image: 'base64 PNG/JPEG/WebP (<=256 KB decoded), or null' } },
  { method: 'GET', path: '/oauth/apps/:identifier/icon', auth: 'Public when app and public OAuth profile enabled', description: 'Serve stored raster icon; fixed MIME and nosniff' },
  { method: 'GET', path: '/oauth/social/google', auth: 'Public profile with registered native app and mandatory S256',
    description: 'Start Google authentication using stored app policy', query: { client_id: 'public client', redirect_uri: 'exact registered URI',
      code_challenge: 'S256 challenge', code_challenge_method: 'S256', state: 'opaque state', scope: 'requested scope', resource: 'optional resource' } },
  { method: 'GET', path: '/oauth/social/complete', auth: 'Secure HttpOnly public completion cookie', description: 'Render hosted completion/second-factor screen' },
  { method: 'POST', path: '/oauth/social/complete', auth: 'Same-origin JSON plus Secure HttpOnly completion cookie',
    description: 'Complete current second-factor and signature policy, then issue public PKCE code', body: { code: 'optional six digit TOTP', setup_token: 'optional enrollment token' } },
];

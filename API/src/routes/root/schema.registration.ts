import type { EndpointSchema } from './schema.js';

const context = {
  config_url: 'Required HTTPS signed website config URL, verified on every request',
  code_challenge: 'Required original 43-character S256 PKCE challenge',
  code_challenge_method: 'Required S256',
  redirect_url: 'Optional original registered callback',
  state: 'Optional opaque original relying-party CSRF state',
  request_access: 'Optional original access-request flag',
};
const browserAuth = 'Original registration-specific HttpOnly cookie, exact verified config and original OAuth context';

export const registrationVerificationEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/auth/registration/start', description: 'Begin browser-bound email registration; sends one neutral link/code email without exposing account state.',
    auth: 'Verified config_url; same-origin browser request', query: context, body: { email: 'Email address' },
    response: { message: 'We sent instructions to your email', registration_id: 'Random public UUID; never sufficient authorization', expires_at: '15-minute deadline; browser credential is only in Set-Cookie' },
    notes: 'Preserves the signed-config inline_sign_in opt-in (409 EMAIL_ALREADY_REGISTERED). Otherwise response shape is identical for new, existing, blocked and malformed addresses. Legacy POST /auth/register and /auth/start retain their existing contracts.' },
  { method: 'GET', path: '/auth/registration/status', description: 'Authoritative pending-registration state; safe to recheck after refresh, reconnect or notification.',
    auth: browserAuth, query: { ...context, id: 'Pending registration UUID' },
    response: { status: 'pending | verified | authorized | complete | expired', token: 'Only when authorized: short-lived browser-bound completion proof', token_type: 'Only when authorized: LOGIN_LINK | VERIFY_EMAIL | VERIFY_EMAIL_SET_PASSWORD' } },
  { method: 'POST', path: '/auth/registration/code', description: 'Verify a six-character uppercase code only for the original requesting registration/browser. Five failed attempts exhaust it across replicas.',
    auth: browserAuth, query: context, body: { id: 'Pending registration UUID', code: 'Six characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789; lowercase normalized' },
    response: { status: 'authorized', token: 'Browser-bound completion proof', token_type: 'Next existing email continuation type' } },
  { method: 'GET', path: '/auth/registration/events', description: 'Authenticated WebSocket upgrade; only non-secret verification hints. Database state remains authoritative.',
    auth: `${browserAuth}; exact canonical Origin`, query: { ...context, id: 'Pending registration UUID' },
    response: { event: '{type:"registration.email_verified",status:"verified"}' },
    notes: 'Immediate process-local hints plus a 5-second cross-replica database recheck. Clients recheck status on load/reconnect and poll every 10 seconds if notifications are lost or WSS is blocked. Two subscriptions per registration and 256 per instance maximum.' },
  { method: 'GET', path: '/auth/registration/link', description: 'Isolated email confirmation page, usable on any browser/device. Link secret is in the fragment, removed immediately; GET has no verification effect.',
    auth: 'None; confirmation requires the secret token in POST', response: { html: 'Explicit confirmation, then email-verified success; never an OAuth redirect or login' } },
  { method: 'POST', path: '/auth/registration/link', description: 'Confirm email from any device and approve continuation of the exact original pending registration.',
    auth: '256-bit email-link token; same-origin POST', body: { token: 'Secret from the emailed URL fragment' }, response: { status: 'verified' },
    notes: 'The original browser receives a WebSocket hint, rechecks status with its cookie and exact OAuth context, and advances without code entry. The confirming browser receives no credentials, cookie or redirect. Replay cannot transfer approval to another flow. No account, OAuth code or session is created here.' },
];

export const registrationVerificationDocumentation = {
  endpoints: registrationVerificationEndpoints,
  completion: 'POST /auth/verify-email consumes an authorized registration. Namespaced registration.* proofs additionally require the original cookie and exact immutable OAuth/config context. Existing epoch, membership, TOTP, agreement and one-use issuance gates remain authoritative.',
  security: 'Explicit confirmation with the secret email link approves its original pending registration on any device. Only the original HttpOnly cookie and exact OAuth/config binding can retrieve and consume completion proof. The confirmation page explains this approval and never signs the confirming browser in. GET and link previews do not approve anything.',
};

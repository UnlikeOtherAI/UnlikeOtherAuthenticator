import type { EndpointSchema } from './schema.js';
const base = '/apps/v1/nessie/phone-profile/';
const subject = { product: 'nessie', organisation_id: 'exact organisation', team_id: 'exact active team', user_id: 'signed-in subject' };
const auth = 'Nessie customer_lifecycle X-UOA-App-Key + exact-endpoint RS256 X-UOA-Actor; live identity/epoch/membership checks';
const profile = { phone: 'null | {number:string|null,pendingNumber:string|null,verifiedAt:ISO|null,visibility:private|team}' };
export const telephoneEndpoints: EndpointSchema[] = [
  { method: 'POST', path: base + 'read', auth, description: 'Read only the acting person’s UOA telephone profile.', body: subject, response: profile },
  { method: 'POST', path: base + 'start', auth, description: 'Issue a six-digit contact challenge for backend SMS delivery; five per user and number per 15 minutes.',
    body: { ...subject, number: 'canonical E.164 +[1-9][0-9]{6,14}' },
    response: { challengeId: 'UUID', expiresAt: 'ISO, five minutes', delivery: '{number,code}; trusted backend only, MUST NOT reach browser/logs' } },
  { method: 'POST', path: base + 'verify', auth, description: 'Consume challenge once; five failed guesses exhaust it. Preserve old number until successful verification.',
    body: { ...subject, challengeId: 'UUID', code: 'six digits' }, response: profile },
  { method: 'POST', path: base + 'remove', auth, description: 'Remove own verified/pending telephone and invalidate outstanding challenges.', body: subject, response: profile },
  { method: 'POST', path: base + 'visibility', auth, description: 'Set colleague display visibility; private still permits internal owner routing.',
    body: { ...subject, visibility: 'private | team' }, response: profile },
  { method: 'POST', path: base + 'lookup',
    auth: 'Nessie customer_lifecycle X-UOA-App-Key + X-UOA-Service-Assertion; no human actor header',
    description: 'Call-bound routing hint in exact live team; never authentication or authority.', body: { number: 'canonical E.164' },
    response: { match: 'null | {state:pending} | {state:ambiguous} | {state:verified,subject,verifiedAt}', authentication: 'none' },
    notes: 'RS256 service assertion typ=uoa-telephone-routing+jwt, exact endpoint aud, registered iss/kid, purpose=telephone-routing, product=nessie, organisation_id, team_id, call_id, number_digest=SHA256(number), jti, iat, exp<=iat+60. No sub/tv. 120 new calls/minute/key persisted; retries retain exact number/team binding and recheck current state. No profile visibility returned.' },
];

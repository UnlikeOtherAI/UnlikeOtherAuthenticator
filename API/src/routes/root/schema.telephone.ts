import { telephoneCallProofEndpoints } from './schema.telephone-call-proof.js';
import type { EndpointSchema } from './schema.js';
const base = '/apps/v1/nessie/phone-profile/';
const subject = { product: 'nessie', organisation_id: 'exact organisation', team_id: 'exact active team', user_id: 'signed-in subject' };
const auth = 'Nessie customer_lifecycle X-UOA-App-Key + exact-endpoint RS256 X-UOA-Actor; live identity/epoch/membership checks';
const profile = { phone: 'null | {number:string|null,pendingNumber:string|null,verifiedAt:ISO|null,visibility:private|team}' };
export const telephoneEndpoints: EndpointSchema[] = [
  ...telephoneCallProofEndpoints,
  { method: 'POST', path: base + 'sms-admission',
    auth: 'Nessie CUSTOMER_LIFECYCLE key + exact-endpoint uoa-telephone-sms-routing+jwt X-UOA-Service-Assertion; no actor',
    description: 'Verified same-team SMS sender eligibility bound to Twilio MessageSid; never private-context or login authority.',
    body: { number: 'canonical E.164' },
    response: { 200: '{status:admitted,authentication:none,eligibility:verified_team_number,subject,tokenVersion,organisationId,teamId,accountSid,messageSid,issuedAt,expiresAt,ownerActive?:true} or {status:pending|ambiguous|no_match|invalid|owner_inactive,authentication:none,ownerActive?:true}' },
    notes: 'Strict RS256 claims: iss,aud,purpose=telephone-sms-routing,product=nessie,organisation_id,team_id,account_sid,message_sid,number_digest,jti,iat,exp<=iat+60; optional owner_subject. Nessie verifies Twilio signature first. Private verified profiles eligible. Durable 120 new messages/min/key, immutable message binding, live membership/epoch on retry. Optional owner_subject independently checks exact-team membership; removed owner refuses. No profile visibility or browser token.' },
  { method: 'POST', path: base + 'call-admission',
    auth: 'Nessie CUSTOMER_LIFECYCLE key + exact-endpoint uoa-telephone-routing+jwt X-UOA-Service-Assertion; no human actor',
    description: 'Explicit lower-assurance registered-caller-ID admission for the exact call; no fresh possession proof.',
    body: { number: 'canonical E.164; prior exact call/team/number lookup required' },
    response: { 200: '{status:admitted,authentication:registered_caller_id,assurance:registered_caller_id,possession_verified_this_call:false,subject,tokenVersion,organisationId,teamId,callId,issuedAt,expiresAt} or {status:pending|ambiguous|no_match|invalid|owner_inactive,authentication:none,ownerActive?:true}' },
    notes: 'Five-minute validity; renew only after live checks. First subject/epoch/verified-number version remains bound to call. Optional owner_subject must match prior lookup and attests current exact-team membership with ownerActive:true or refuses owner_inactive. No profile visibility, browser token or login session. Does not prevent caller-ID spoofing.' },
  { method: 'POST', path: base + 'set', auth, description: 'Record a pending number without sending a code; preserve existing verified number and invalidate challenges.',
    body: { ...subject, number: 'canonical E.164' }, response: profile },
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
    notes: 'RS256 service assertion typ=uoa-telephone-routing+jwt, exact endpoint aud, registered iss/kid, purpose=telephone-routing, product=nessie, organisation_id, team_id, call_id, number_digest=SHA256(number), jti, iat, exp<=iat+60. Optional owner_subject binds a personal routing owner, including in later admission/proof assertions. No sub/tv. 120 new calls/minute/key persisted; retries retain exact number/team binding and recheck current state. No profile visibility returned.' },
];

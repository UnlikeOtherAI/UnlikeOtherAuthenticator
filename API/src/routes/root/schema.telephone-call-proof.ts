import type { EndpointSchema } from './schema.js';
const base = '/apps/v1/nessie/phone-profile/call-proof/';
const auth = 'Nessie customer_lifecycle X-UOA-App-Key + RS256 X-UOA-Service-Assertion; no X-UOA-Actor';
const notes = 'Strict service claims: registered iss/kid, exact endpoint aud, purpose=telephone-call-proof, typ=uoa-telephone-call-proof+jwt, product=nessie, organisation_id, team_id, call_id, number_digest=SHA256(E164), jti, iat, exp<=iat+60. No sub/tv.';
export const telephoneCallProofEndpoints: EndpointSchema[] = [
  { method: 'POST', path: base + 'start', auth, notes,
    description: 'Issue one call-bound SMS code for a unique current verified telephone member after bound routing lookup.',
    body: { number: 'canonical E.164' },
    response: { status: 'challenge | pending | ambiguous | no_match', challengeId: 'UUID on challenge only',
      expiresAt: 'ISO; five-minute code lifetime', delivery: '{number,code}; backend only, strip before browser/logs',
      authentication: 'none on refusal' } },
  { method: 'POST', path: base + 'reserve', auth, notes,
    description: 'Reserve prepaid OTP delivery against the exact active funded team allocation; never fabricate a human actor.',
    body: { number: 'issued challenge destination', challengeId: 'UUID', dispatch_id: 'stable physical send id, <=160 chars',
      request_fingerprint: 'lowercase SHA256 hex', number_id: 'paid sender resource', allocation_id: 'active funded selected-team allocation',
      account_sid: 'AC + 32 hex', from: 'acquired sender E.164', max_segments: 'integer 1..3' },
    response: { dispatch_id: 'string', reservation_id: 'string', state: 'existing BillingSmsReservationV1 state',
      dispatch_token: 'null until ordinary SMS_RUNTIME claim', reserved_credits: 'decimal string',
      consumed_credits: 'decimal string|null', message_sid: 'string|null' } },
  { method: 'POST', path: base + 'verify', auth, notes,
    description: 'Consume six-digit call code once; current identity/epoch/membership/telephone binding required. Never issues a login.',
    body: { number: 'canonical E.164', challengeId: 'UUID', code: 'six digits from live call' },
    response: { status: 'verified | invalid | expired | used | pending | ambiguous | no_match',
      authentication: 'telephone_sms on success; none otherwise',
      subject: 'UOA subject only on success', tokenVersion: 'current epoch only on success',
      organisationId: 'exact org only on success', teamId: 'exact team only on success', callId: 'exact call only on success',
      verifiedAt: 'ISO only on success', expiresAt: 'ISO five minutes after verification, only on success' } },
];

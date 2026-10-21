export const llmTelephoneMarkdown = `
## UOA personal telephone profile for Nessie
Use POST /apps/v1/nessie/phone-profile/{read,set,start,verify,remove,visibility} with
Nessie's customer_lifecycle X-UOA-App-Key and fresh exact-endpoint X-UOA-Actor.
Body includes product:"nessie", organisation_id, team_id, user_id; only the actor's
own profile is accessible. Set adds number and stores pendingNumber without SMS,
preserving the verified number and invalidating outstanding challenges. Start adds number in canonical E.164 and returns
{challengeId,expiresAt,delivery:{number,code}}. UOA stores a keyed code digest;
Nessie sends the SMS and MUST strip delivery before replying to the browser.
Never log that response. Verify adds challengeId/code. Codes last five minutes,
allow five guesses, bind the original user/epoch/app key and are invalidated by
resend/removal. Issuance is capped at five per person and number per 15 minutes.
An old verified number survives until replacement verifies. Read/set/verify/visibility
return {phone:{number,pendingNumber,verifiedAt,visibility}|null}. Visibility is
private by default and on replacement; it controls colleague display only.

GET /org/organisations/:orgId/teams/:teamId/members adds optional
data[].identity.telephoneNumber for verified team-visible numbers only. Both
caller and subject must have live membership in the exact selected team and org.
Private/pending numbers, inactive members and backend mode without a person omit
the field. Nessie may render it in the existing team/person view, never persist it.

POST /apps/v1/nessie/phone-profile/lookup takes {number} with the app key and a
separate X-UOA-Service-Assertion: RS256 typ=uoa-telephone-routing+jwt, registered
iss/kid, aud=PUBLIC_BASE_URL plus exact lookup path, purpose=telephone-routing,
product=nessie, organisation_id, team_id, call_id, number_digest=hex SHA256 of
canonical E.164, jti, iat, exp at most 60 seconds later. No sub or tv is accepted.
Use one stable opaque call_id per inbound call. Changing its number/org/team is
refused. UOA checks live active identity and exact org/team membership even for
private numbers; returns {match:null|{state:"pending"}|{state:"ambiguous"}|
{state:"verified",subject,verifiedAt},authentication:"none"}. No subject is exposed
for pending/ambiguous. Unknown is null; pending/ambiguous must not enter an
outside Clients conversation. Verified is only a routing candidate. Spoofable
caller ID and historical SMS verification NEVER authorize private context,
tools or a signed-in session: Nessie must obtain separate per-call proof.
For a verified routing candidate, use POST /apps/v1/nessie/phone-profile/call-proof/start
with {number}. Service assertion uses purpose=telephone-call-proof and
typ=uoa-telephone-call-proof+jwt with the same strict routing claims and exact
endpoint aud. A prior lookup must bind this key/call/number/team. Start returns
{status:"challenge",challengeId,expiresAt,delivery:{number,code}} or
{status:"pending"|"ambiguous"|"no_match",authentication:"none"}. Strip delivery
from public responses/logs. Codes last five minutes; five guesses; three starts
per call and five per person/destination in 15 minutes. Start assertion replay refuses.

Before sending code, POST call-proof/reserve with {number,challengeId,dispatch_id,
request_fingerprint,number_id,allocation_id,account_sid,from,max_segments} and a
fresh exact-reserve call-proof assertion. Segments must be 1–3. UOA checks the
challenge, active funded selected-team standing hold, paid acquired sender and
same-country destination; it quotes and reserves prepaid credits. Response is
BillingSmsReservationV1. Existing SMS_RUNTIME reservation/claim/receipt/release
protocol completes delivery; never send without the one-use claim token. One
challenge allows one immutable dispatch. Insufficient credit is HTTP 402 with
code BILLING_SMS_INSUFFICIENT_CREDITS and can_dispatch:false.

Collect six DTMF digits and POST call-proof/verify with {number,challengeId,code}
and a fresh exact-verify service assertion. Success returns {status:"verified",
authentication:"telephone_sms",subject,tokenVersion,organisationId,teamId,callId,
verifiedAt,expiresAt}; expires five minutes after verification. It is neither an
OAuth token nor a browser login. Keep only on that call and check live UOA
membership/epoch before private tools. Consumed challenges return used; refusals
return {status:"invalid"|"expired"|"used"|"pending"|"ambiguous"|"no_match",
authentication:"none"}, no subject. Lookup no_match remains an external caller,
not a member. No code or proof may become a reusable session.

All reads are private/no-store, with no positive cache. Machine-readable bodies
and responses are listed at /api. These are machine-only endpoints; Nessie's
personal profile owns the phone form and SMS code-entry doorway.
`;

export const llmTelephoneAdmissionMarkdown = `
## Registered caller-ID admission
POST /apps/v1/nessie/phone-profile/call-admission with {number} uses the same service
assertion shape as lookup, but the exact new endpoint audience. Require prior lookup
for that call/team/number. Success returns status=admitted,
authentication=registered_caller_id, assurance=registered_caller_id,
possession_verified_this_call=false, subject, tokenVersion, organisationId, teamId,
callId, issuedAt and expiresAt (five minutes). Refresh requires live identity,
membership and verified-number checks; the first subject/epoch/number version cannot
change within a call. Pending, ambiguous, no_match and invalid return authentication=none
without subject. This is an explicit lower-assurance product policy for ordinary PA
conversation/context without another OTP, not a current possession proof or login.
Do not upgrade it to telephone_sms. Sensitive actions require stronger policy/proof.
Caller-ID spoofing remains possible. UOA issues no browser or refresh session here.
`;

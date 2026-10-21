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
All reads are private/no-store, with no positive cache. Machine-readable bodies
and responses are listed at /api. These are machine-only endpoints; Nessie's
personal profile owns the phone form and SMS code-entry doorway.
`;

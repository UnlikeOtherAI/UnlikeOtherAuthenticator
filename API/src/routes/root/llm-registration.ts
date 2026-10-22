export const llmRegistrationMarkdown = `
## Browser-bound registration verification

The hosted registration screen uses POST /auth/registration/start with {email},
the verified config_url and original OAuth context (S256 challenge, callback,
state and access-request flag). Its generic response includes registration_id
and expires_at for every ordinary account/eligibility outcome; the signed
inline_sign_in opt-in still permits EMAIL_ALREADY_REGISTERED. A 15-minute,
registration-specific HttpOnly cookie owns the flow. Public IDs are not credentials.

The email contains a secret link and the same six-character code displayed for
entry on the requesting screen. Codes use ABCDEFGHJKLMNPQRSTUVWXYZ23456789,
are hashed with a server pepper, and allow five persisted guesses per registration.
POST /auth/registration/code accepts {id,code} only with that browser's cookie
and exact original OAuth/config context. Link and code converge atomically.

GET /auth/registration/link is an isolated confirmation page. Its URL fragment
holds the 256-bit link secret, so the secret never reaches access logs or
referrers. The page removes the fragment before its explicit confirmation POST.
POST /auth/registration/link with {token} confirms email and returns only
{status:"verified"}; no account, OAuth code or login session is created there.
The link works on any device. Only a matching original browser cookie may also
authorize that pending flow. After a cross-device click the original browser
must still enter the emailed code: an attacker starting a flow with a victim's
email cannot gain access when the victim clicks. Replaying a consumed link never
grants additional browser authority. No second pairing code is introduced.

GET /auth/registration/status and authenticated WSS /auth/registration/events
require the original cookie plus exact signed config and OAuth context; WSS
additionally requires the exact service Origin. Events contain only
{type:"registration.email_verified",status:"verified"}. Clients treat them as
hints and re-read database state on load, reconnect and focus. Process-local
events are immediate; connected replicas recheck the database every five seconds.
A ten-second client poll covers blocked WSS and lost hints. Refresh persists
only the public pending ID and display email; credentials remain HttpOnly.

Status is pending, verified, authorized, complete or expired. Only authorized
responses contain a namespaced registration.* completion proof and token_type.
The existing POST /auth/verify-email performs password setup or the existing
login continuation. Those proofs additionally require the original cookie and
immutable OAuth/config binding, and retain live credential-epoch, team, TOTP,
agreement and one-time account/code issuance checks. Registration codes and
link secrets must never be logged. Expired pending records are pruned.
Legacy POST /auth/register and /auth/start retain their existing contracts.
See GET /api for the full machine-readable endpoint schema.
`;

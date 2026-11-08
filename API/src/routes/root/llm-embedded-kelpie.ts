export const embeddedKelpieMarkdown = `# Kelpie embedded host sessions

Nessie embeds the complete Kelpie browser and supplies its existing UOA session.
The native provider holds a short-lived scoped access grant in memory. Nessie
retains the original encrypted UOA refresh credential and assurance reference;
neither is copied into Kelpie. UOA remains the only profile and settings authority.

## Issue and custody

POST /org/me/kelpie/session?domain=<gateway-host>&config_url=<signed-product-config>
requires the current product domain credential and exactly one existing person
credential: X-UOA-Subject-Assertion or X-UOA-Access-Token. The JSON body is empty.
The signed assertion uses the existing /org audience and original assurance
reference. The source must be the exact KELPIE_CONNECT_RESOURCE host. An enabled
ClientDomain and a live independent original session proof are mandatory even
below the product compatibility floor. Missing proof never upgrades a legacy
session. Organisation-only enterprise and recovery proof cannot authorize global
profile, bookmarks or browser account connectivity.

Success returns access_token, token_type=Bearer, expires_in (at most 120 seconds),
sub and issuer. The RS256 at+jwt has token_use=embedded_kelpie_account and exact
audience <UOA issuer>/embedded/kelpie. Its fixed scope is profile email
settings.read settings.write kelpie.connect. It records only subject, source
domain and ClientDomain id, original assurance id, original org/team scope,
credential epoch, issued/expiry timestamps and jti. No profile, assurance reference,
domain bearer or refresh credential enters it. It never creates an OAuthClient,
native registration, identity or refresh family.

Only the trusted main product document may request this grant through its backend.
The native host keeps it in memory, replaces it before expiry and retires it on
account/session replacement, navigation, revocation or sign-out. Arbitrary pages
inside Kelpie never receive the host bridge or the grant.

## Account operations

The provider maps the SDK's /oauth prefix to /embedded/kelpie for these paths:

- GET /me: current UOA sub/email/name.
- GET /me/avatar: UOA-resolved bytes.
- GET and PUT /me/settings/:namespace/:key: the same authoritative settings rows
  and ETag/If-Match compare-and-swap semantics as native public accounts.
- GET /me/settings/:namespace/:key/events: the same version1 snapshot/delta stream.
- POST /connect with the exact operator resource: a separate agent gateway ticket.

HTTP profile and settings routes share one implementation with standalone native
accounts. Streams share admission limits, per-subject limits and a serial read lane.
All authority is rechecked before delivery and during the 30-second repair. Expiry
closes a stream; reconnect obtains a fresh host grant and current snapshot. HTTP
and stream failures retain status codes and never invent an empty successful result.

Each request rechecks the enabled source domain, current subject and domain role,
credential epoch, original proof and live family/ancestors, exact original
memberships, current independent-factor admission, bans, factor and signature policy.
The original proof's absolute expiry bounds every derived grant and ticket.
The public OAuth feature gate and registered-native consent rules remain unchanged;
embedded operations do not require or enable public registration.

## Gateway ticket

POST /embedded/kelpie/connect issues token_use=embedded_kelpie_connect with exact
audience KELPIE_CONNECT_RESOURCE, capped by the source grant and original proof.
It cannot authenticate an account endpoint, a native pairing endpoint or a refresh.
The SDK transports it only in the gateway authentication frame.

The gateway calls POST /embedded/kelpie/connect/validate?domain=<gateway-host>
with its existing domain bearer and {ticket}. This is the combined strict gateway
validator: standalone tickets retain all existing native checks and require the
public profile; embedded tickets retain the original host proof and live source
checks. The decoded token class selects a verifier only; signed class, issuer,
audience, lifetime and source are verified before admission. The backend credential
is rechecked under the same policy lock.

Success adds source=native or embedded to the existing profile-free validation
response. Embedded client_id is embedded:<ClientDomain id> and app_id is
embedded:<source domain>; neither impersonates com.unlikeotherai.kelpie.
The gateway retains its admission, before-dispatch and 30-second validation checks.
Failed validation or expiry closes the connection. Selected-team execution
entitlements remain the gateway product's independent live UOA checks.

## Rollout and verification

Deploy UOA before the consuming Nessie backend and native apps. No new operator
record, credential, public native registration or migration is required; the existing
gateway resource, source domain and original-proof custody must already be configured.
Source support alone does not prove that any consumer or native package is live.

With an isolated migrated DATABASE_URL exported, run API typecheck/lint and
tests/integration/embedded-kelpie.test.ts together with standalone native account,
connection, settings-stream and confidential original-proof regressions. These
machine-only APIs have no UOA UI. Nessie owns reachable browser entry points and
must verify installed native flows, account replacement/sign-out, live agent
connectivity and recovery separately.
`;

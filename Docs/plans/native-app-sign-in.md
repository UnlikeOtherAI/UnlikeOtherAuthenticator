# Admin-managed native app sign-in

## Problem and decision

Native public OAuth currently synthesizes a neutral password-only config. Kelpie
therefore cannot show its icon or Google on the real UOA hosted page. Native apps
cannot keep the confidential signed-config credential. Operators will manage an
independent **Apps** section for public native sign-in, separate from feature flags
and billing app keys. Existing signed-config and confidential exchange stay unchanged.

## Authority and data

Add NativeApp: immutable reverse-domain identifier, display name, enabled flag,
monotonic revision, exact callback allowlist, scope allowlist, enabled methods
(email_password / google initially), registration policy, primary/background/text
colors and uploaded raster icon. Only current admin superusers can read/write this
control plane. Reuse bounded PNG/JPEG/WebP validation; no SVG or remote icon fetch.
Public icon responses use fixed MIME, nosniff and no-store. Admin changes are audited.

Extend OAuthClient with optional nativeAppId and nativeAppRevision. Public dynamic
registration accepts app_id. For a registered app, the server intersects requested
scopes and checks every redirect against its stored list. It issues the existing
random client_id bound to the current app revision. Unregistered DCR clients retain
neutral branding and cannot acquire branding by choosing client_name. Every client
resolution rejects disabled/deleted/stale app registrations. Updating app policy
therefore invalidates pending flows and tokens, including after re-enabling.

Use exact redirect matching, with RFC 8252's port-only exception for numeric
loopback HTTP URIs; no hostname/wildcard/path/query substitution. Native clients
still validate their exact callback and state. Custom schemes can be claimed by
another installed app: public app IDs are labels, never binary attestation.

## Hosted authentication

The server builds public ClientConfig from the stored profile, keeping the dedicated
native domain, global account identity, mandatory S256, and enabled second-factor
policy. Password login retains its current implementation. Native Google starts at
/oauth/social/google. A random public flow ID references the complete authorization
context in a short-lived database row. An independent random per-flow __Host- cookie
is bound by its stored hash; provider state alone is insufficient. Reuse the already
registered /auth/callback/google with a separate native flow prefix and database +
browser-cookie verification. Confidential signed state cannot enter this branch.
Revalidate app/client/redirect/scopes at callback and every continuation.

Reuse verified Google identity resolution, bans, credential epoch locks, required
TOTP/enrollment, and signature gate. Social second-factor continuation retains the
per-flow opaque HttpOnly/Secure cookie with SameSite=Strict after returning from
Google. The rendered page includes its public flow ID; every completion POST binds
that ID to its own cookie and stored context. The row records the authenticated user
and credential epoch, expires after 15 minutes, and is atomically consumed in the
code-issuance transaction. Expired records are pruned at new flow creation. No access
token or signed identity capability travels in the page URL. The cookie never grants
access without current policy and PKCE. Successful Google authentication can
create an account only when app registration policy permits. Password creation and
password recovery are not advertised for native flows until supported end to end.

The final redirect contains only a one-use, short-lived authorization code plus
the original state. Existing /oauth/token verifies S256 and returns an in-memory
session token. No refresh grant, session tokens in URLs, privileged scopes, or
consent bypass based on app_id. Google may reuse its existing browser session;
the hosted page still shows the app, destination and requested account access.

## Kelpie and delivery

All desktop and mobile registrations send app_id=com.unlikeotherai.kelpie while
retaining their fresh state/verifier and existing callbacks. Provision the profile
through the same audited service used by Admin, with the existing Kelpie icon,
Google + password and explicit personal-settings scopes. Never seed operator state
implicitly in a migration. Deploy UOA first; visually verify logo, colors and real
Google authorization destination. Build/release/install affected native clients.

## Verification

Test unauthorized admin access, invalid identifiers/icons/colors, redirect/scope
widening, forged branding, app disable/revision invalidation, social state/cookie
tampering, provider mismatch, verified-email requirement, TOTP/epoch enforcement,
code replay and wrong PKCE. Run API/Auth/Admin typecheck, lint, targeted tests,
build, migration integration and existing public/confidential auth regression gates.
Native builds run on their owning OS; report authenticated E2E limitations honestly.

## Cross-Provider Review

Claude reviewed the design against the source on 2026-09-25. Accepted: use a
separate strict public social-state schema/issuer; branch before confidential
completion; reject unverified Google email without sending email; prohibit hard
deletion and reserve identifiers; revalidate inside code issuance and account
writes under the existing product-policy lock. Security edits increment revision;
cosmetic edits do not. DCR's loopback port exception applies only at registration.
Use __Host- continuation cookies with Path=/ (a narrower path is incompatible with
that prefix), Secure/HttpOnly/SameSite=Strict. Rate-limit completion by user and IP.
Construct the trusted same-service icon URL only after normal config validation,
without relaxing signed-config validation. Public native tokens remain user-role
tokens; native registration cannot confer administrative access. Existing external
resource tokens verified offline remain valid until expiry; immediate revocation
applies to UOA account endpoints. Keep public completion separate from confidential
2FA artifacts and bind the complete request, current epoch and factor policy before
issuing any code. The implementation review below replaces the initially proposed
signed completion ticket with a one-use database record. All native apps share the existing native tenant's
ban/2FA/signature policies; app registration=false is an additional hard gate.

### Implementation review resolution

Claude's implementation review identified shared-cookie cross-flow confusion,
completion replay, nested database pool acquisition and state-length limits. The
final implementation uses the single durable NativeOAuthFlow described above,
per-flow cookies, compare-and-set callback/completion consumption, and transaction-
scoped client lookups. This removes the proposed extra public JWT formats entirely.
Public password/token transactions also use the explicit admin connection: public
client and global identity lookup precede tenant context, with exact user/PKCE and
current policy checks at each boundary. No RLS grants are widened. Google requests
account selection. Completion shows the app, destination and requested access.
Cancellation returns access_denied plus original state; the page removes used Google
query parameters after hydration. No native registration performs automatic team
placement. Audit entries include the changed security policy. Existing signed
website configuration, social state and confidential code grants stay unchanged.

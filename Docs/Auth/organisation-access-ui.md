# Organisation access settings

The customer-facing home for enterprise connections is UOA Auth at
`/auth/organisation-access`. It uses the Auth theme, language selector and
shared form controls. It is separate from the platform-superuser Admin app;
an organisation owner does not need platform administration rights.

The consuming product obtains an exact organisation/client reauthentication link
through its authenticated backend. This `/auth` link names the organisation but
carries no management authority. UOA asks for independent personal sign-in, keeps
the owner chooser visible even with one team, and offers only the requested
organisation. Owners without teams are supported. Ownership hints come from the
server; role names do not grant management access. The start endpoint rechecks
current ownership and completes existing personal-factor policy before redirecting
to a one-use browser-bound management fragment. No product code or refresh family
is issued for this purpose.

The browser removes the fragment immediately and exchanges the continuation for
a protected management cookie. The frontend retains only the server's CSRF value
and settings in memory. It never receives a product bearer or refresh token.
Reload hydrates the cookie session; expired authority requires fresh sign-in.

Local verification uses `pnpm --filter @uoa/auth exec vitest run --config
vitest.management.config.ts` after building Auth and its API dependency packages,
with `DATABASE_URL` set to an isolated UOA test database and `PLAYWRIGHT_MODULE`
pointing to the installed Playwright entry. This local-only headless journey uses
real Fastify routes and a migrated random PostgreSQL schema. Only the public
signed-config/JWKS transport uses the existing test fixture; production SSRF,
proof, factor and cookie checks remain active. It is not a vendor certification.

## Customer journey

First use explains single sign-on and opens **Choose provider**. Returning
owners see saved connections. The exact organisation and consuming domain
remain visible throughout setup.

1. Choose a server-advertised provider. UOA reserves a draft with a stable
   reply URL and SAML service-provider identity before asking for credentials.
2. Connect using the preset's required fields. Entra and Workspace provide
   their fixed protocol settings; Okta and Keycloak need only their exact
   organisation/realm issuer, client ID and secret. The server resolves discovery
   and owns every secret-bearing endpoint allowlist; the browser cannot bless
   endpoints by listing them as trusted. Other OIDC providers also require
   explicit signed tenant proof. Connection credentials are write-only. Leaving an existing secret
   field empty preserves it.
3. Copy the generated reply URL or SAML service-provider details shown above
   the credential fields into the provider, save, then run a real server-owned test. Test mode grants no product
   access. The result is bound to the saved configuration revision; editing
   requires another test. Failed tests leave the connection editable.
4. Turn on only when the server reports readiness and the saved revision has
   passed. Missing account-assurance, product migration, revocation or recovery
   prerequisites remain explicit blockers. A setup form is not evidence of
   provider compatibility or rollout readiness.

Email-domain verification has its own view, with TXT record copy actions and
an explicit DNS check. New TXT values are shown from the one-time creation or
reissue response and held only in component memory. After leaving the page,
an owner can atomically request a new record for a pending, expired or lapsed claim.
An explicit stop-using-domain action explains suspension and that re-verifying
DNS will not automatically restore domain-derived access.
Verification alone neither turns on discovery nor
requires single sign-on. Recovery has a reachable setup view: choose two active
organisation members with existing personal UOA authenticators. The canonical
owner may be one of the two. The invitation response shows each recovery link
once, for private handoff; no link is persisted in browser storage. Each contact
opens `/auth/organisation-recovery`, which removes its fragment before requesting
a browser-bound challenge. Confirmation and practice each require a new personal
factor code. Emergency recovery explicitly warns that it disables only the named
organisation/product enforcement and suspends its provider connections; it grants
no account access or ownership. Required sign-in remains gated by server readiness.
Activation also respects UOA's custom commercial arrangement;
Nessie has no billing or subscription gate for SSO or its associated SCIM.

Optional provisioning appears within the selected connection. When the server
enables it, token issuance displays the plaintext once in component memory;
dismissing or leaving that connection removes it. Revocation uses the same
protected API. The selected connection also exposes pending provisioner people
and independently linked provider subjects. Reconciliation requires an explicit
stable identity selection; the UI never suggests an email/name match as proof.
No Nessie subscription or billing gate is involved.

SAML setup accepts pasted or local-file metadata XML through the owner API parser;
it never fetches a customer-supplied metadata URL. Parsed values fill the existing
form for review and save. Connection details contain credential replacement and
SAML service-provider certificate preparation, tested activation and tested old-key
retirement. Every revision requires a new sign-in test.

An existing-account link lands in a dedicated personal-proof form at the normal
Auth home. It supports the configured personal password path or an already enrolled
UOA authenticator, using the original browser-bound link intent. It offers no new
factor enrollment, mailbox-only proof, registration or social bypass. The final
product continuation retains SSO provenance; personal linking proof does not turn
the product result into organisation-management authority.

All new copy is provided in the Auth app's three built-in languages: English,
Czech and Spanish. Unknown diagnostic codes are replaced with a plain launch
prerequisite message; raw claims, tokens and protocol errors are not rendered.

The home also links to **Who can sign in**. This single owner policy form keeps
new-user joining and unverified-domain contractors off by default, chooses the
exact UOA team for verified-domain joining, and maps an explicitly selected connection plus its exact group IDs
to that organisation's teams with member or team-administrator roles only. It
never creates another owner. Required sign-in options remain disabled until UOA
reports enforcement readiness; the optional mode stays available for recovery.
Discovery is an explicit owner choice, separate from verifying a domain.

## Local evaluation

Run Auth's Vite server on a free port and verify `@vite/client` is served.
Then run `node Auth/e2e/organisation-access.mjs`, with `UOA_AUTH_PREVIEW`
pointing at that server and `PLAYWRIGHT_MODULE` if Playwright is supplied by
the local runtime rather than workspace dependencies. The script launches
headless Chromium, supplies an isolated API fixture through request routing,
and saves screenshots under ignored `Auth/e2e/artifacts/organisation-access`.
It checks the first-use setup, required preset inputs, a saved connection,
passed and failed tests, blocked activation, pending DNS proof, recovery,
Czech/Spanish copy, outage, expired sessions, SAML setup and one-time
provisioning-token dismissal, explicit identity reconciliation, policy save and
failed credential replacement at 390px and 1280px.
The fixture never replaces production persistence or runs in CI. These browser
checks establish rendering and client behavior; live provider and server
security tests remain separate requirements.

`Auth/src/utils/organisation-access.test.ts` covers one-use fragment cleanup,
StrictMode exchange deduplication, scoped CSRF mutations, malformed responses,
test destination restrictions, lost-response cookie recovery, retryable bootstrap
failures and outage refusal. Domain TXT proofs remain in component memory only;
ordinary hydration does not retrieve their plaintext.

The separate local command
`pnpm --filter @uoa/auth exec vitest run --config vitest.ui.config.ts` runs
`Auth/e2e/ConnectionForm.ui.tsx`. It checks reply details precede credentials,
minimal issuer setup never supplies trusted endpoints, and failed saves preserve
the entered secret. Its filename and explicit configuration keep these rendered
component checks out of the ordinary unit command and CI.

The real-route management browser suite also exercises first-use recovery contact
save without a prior SSO policy, browser-bound contact confirmation and a separate
fresh authenticator-code practice. Its account-link cases use both real password
and existing-factor routes, a registered revocation consumer with exact HMAC
capability acknowledgment, and assert the resulting product evidence retains SSO
provenance. Fixture TOTP codes wait for the next actual counter; replay protection
is never reset to speed up the journey. No invitation handle or issued product
code is captured in screenshots.

# Organisation access settings

The customer-facing home for enterprise connections is UOA Auth at
`/auth/organisation-access`. It uses the Auth theme, language selector and
shared form controls. It is separate from the platform-superuser Admin app;
an organisation owner does not need platform administration rights.

The consuming product obtains an exact organisation/client management
continuation through its authenticated backend. The browser receives a
short-lived, single-purpose link, removes its fragment immediately, and
exchanges the one-use continuation for a protected management cookie. The
frontend retains only the server's CSRF value and settings in memory. It
never receives a product bearer or refresh token. Reload hydrates the same
cookie session; an expired/unauthorized session directs the person back to
the product to reopen settings. Every API mutation still requires live server
authorization and suitable fresh proof.

## Customer journey

First use explains single sign-on and opens **Choose provider**. Returning
owners see saved connections. The exact organisation and consuming domain
remain visible throughout setup.

1. Choose a server-advertised provider. UOA reserves a draft with a stable
   reply URL and SAML service-provider identity before asking for credentials.
2. Connect using the preset's required fields. Entra and Workspace provide
   their fixed protocol endpoints; other connections require their provider
   details. Connection credentials are write-only. Leaving an existing secret
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
an explicit DNS check. Verification alone neither turns on discovery nor
requires single sign-on. Recovery is a separate view: it accurately reports
the unresolved independent-recovery gate and exposes no fictitious custodian
enrollment or backup codes. Enforcement remains unavailable until its approved
server workflow exists and has passed verification.

Optional provisioning appears within the selected connection. When the server
enables it, token issuance displays the plaintext once in component memory;
dismissing or leaving that connection removes it. Revocation uses the same
protected API. No Nessie subscription or billing gate is involved.

All new copy is provided in the Auth app's three built-in languages: English,
Czech and Spanish. Unknown diagnostic codes are replaced with a plain launch
prerequisite message; raw claims, tokens and protocol errors are not rendered.

## Local evaluation

Run Auth's Vite server on a free port and verify `@vite/client` is served.
Then run `node Auth/e2e/organisation-access.mjs`, with `UOA_AUTH_PREVIEW`
pointing at that server and `PLAYWRIGHT_MODULE` if Playwright is supplied by
the local runtime rather than workspace dependencies. The script launches
headless Chromium, supplies an isolated API fixture through request routing,
and saves screenshots under ignored `Auth/e2e/artifacts/organisation-access`.
It checks the first-use setup, required preset inputs, a saved connection,
passed and failed tests, blocked activation, pending DNS proof, recovery,
Czech/Spanish copy, outage and expired-session states at 390px and 1280px.
The fixture never replaces production persistence or runs in CI. These browser
checks establish rendering and client behavior; live provider and server
security tests remain separate requirements.

`Auth/src/utils/organisation-access.test.ts` covers one-use fragment cleanup,
StrictMode exchange deduplication, scoped CSRF mutations, malformed responses,
test destination restrictions and outage refusal.

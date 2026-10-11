# Kelpie account connectivity

Kelpie uses the same UOA subject as Nessie and opens an outbound WSS connection to
Nessie's gateway. UOA owns account authority; Nessie owns device execution and resolves
its current team entitlements independently. Connection never creates a user, profile,
organisation, team, invitation, membership or local password in Nessie. A native app ID
is public registration metadata and is not binary attestation.

## Native grant and connection

Register and request `openid profile email settings.read settings.write kelpie.connect`
through the existing exact-callback/S256 native sign-in. Do not request a resource for
that account token: its audience is UOA. The dedicated `kelpie.connect` scope is allowed
only on the current enabled `com.unlikeotherai.kelpie` native app and public clients
registered against that policy. Plain DCR and every other native app are refused.
The hosted consent explains that this connects the device to the person's Nessie
account for work they request. Existing native rotating refresh and secret-store rules
remain in [native accounts](native-accounts.md).

```http
POST /oauth/kelpie/connect
Authorization: Bearer <native UOA account access token>
Content-Type: application/json

{"resource":"https://api.nessie.works/api/kelpie/connect"}
```

Success returns `{connection_ticket, token_type:"Bearer", expires_in, gateway_url}`.
The WSS URL is the configured HTTPS resource with scheme changed to `wss`.
The ticket uses the existing resource RS256 signer and `/oauth/jwks.json`, with protected
header `typ=at+jwt`. Claims are `iss,sub,aud,iat,exp,jti,client_id,app_id,tv,twofa`,
`token_use=kelpie_connect`, and `scope=kelpie.connect`. It contains no email, display
name, avatar, domain role, organisation or team. Lifetime is at most120 seconds and
never beyond the source account token's expiry. No ticket table or profile copy is
introduced. Tickets are bearer capabilities: transport them only over HTTPS/WSS,
never in URLs, logs, persistent settings or unencrypted storage.

Send only the ticket in the gateway's authentication frame. Renew after60 seconds or
earlier according to `expires_in`, using the same account access token while valid.
Native account renewal uses the unchanged rotating refresh endpoint. The gateway
accepts renewal only for the already bound issuer, subject and native client. Reconnect
always obtains a fresh ticket. Account switching/sign-out closes the old socket and
clears its ticket and pending device work.

Every response, including errors, is no-store and every error body is generic.
`401` permits one native access refresh and retry, then fresh sign-in if still refused;
`403` requires consent to the new scope. `400` is an invalid request/resource and does
not erase the account session. `404` means the operator feature or public profile is
disabled; `429`, transport and `5xx` retain native credentials and back off.

## Live gateway authority

```http
POST /oauth/kelpie/connect/validate?domain=api.nessie.works
Authorization: Bearer <Nessie's existing api.nessie.works domain credential>
Content-Type: application/json

{"ticket":"<connection ticket>"}
```

The existing domain guard authenticates the exact backend. The domain must equal the
configured resource host and its active credential is re-resolved under the policy
lock. Valid authority returns `{active:true,iss,sub,aud,client_id,app_id,exp,jti}`;
invalid authority returns generic401. No profile or directory is disclosed.

UOA validates RS256/header/issuer/audience/class/lifetime, then rechecks the current
enabled native app, exact app revision/client, server/client/app scope grants, ACTIVE
subject, credential epoch, second-factor assurance, native login restrictions/bans,
native domain status and signature policy under the existing credential/policy locks.
Native logout, refresh theft detection, password or factor reset, account disable and
native-app security edits therefore refuse the next validation even before ticket
expiry. Cosmetic app edits preserve registration authority.

The gateway validates on admission, before dispatch and at least every30 seconds,
closes on invalid/failed validation, and must close at ticket expiry without a valid
renewal. Validation is a current read, not permission to cache authority indefinitely.
No offline signature success replaces UOA's live credential-epoch check. Membership
and selected-team authorization remain Nessie's independent, live UOA API checks.

## Operator provisioning and migration

This feature is disabled unless `KELPIE_CONNECT_RESOURCE` names one exact
credential-free HTTPS URL with path `/api/kelpie/connect`. Production is
`https://api.nessie.works/api/kelpie/connect`. The dedicated allowlist does not expand
`MCP_OAUTH_RESOURCES_SUPPORTED` or permit generic public OAuth tokens for Nessie.

1. Deploy UOA code and the existing public-profile signing environment. Set the
   repository variable using `gh variable set KELPIE_CONNECT_RESOURCE --repo
   UnlikeOtherAI/UnlikeOtherAuthenticator --body
   https://api.nessie.works/api/kelpie/connect`; the Deploy workflow passes it to Cloud
   Run. Missing variable remains disabled. Dispatch `deploy-main.yml` after changing a
   variable if no code push triggers it. Never place any domain bearer in that variable.
2. If `MCP_OAUTH_SCOPES_SUPPORTED` is explicitly configured, append `kelpie.connect`
   to its existing allowlist and restart/redeploy. The default includes it; registration
   still restricts it to Kelpie. Enabling the public profile is separately required.
3. In **Admin → Integrations → Native apps → Kelpie → Edit**, enable `kelpie.connect`
   alongside its existing scopes. Alternatively export the current policy into an
   operator-owned JSON file, append only that scope, then run the existing audited
   provisioner with credentials supplied only through process environment:

   ```sh
   pnpm --filter @uoa/api exec tsx src/cli/provision-native-app.ts --input /operator/kelpie-policy.json --actor <current-admin-email> --id <existing-Kelpie-row-id>
   pnpm --filter @uoa/api exec tsx src/cli/provision-native-app.ts --input /operator/kelpie-policy.json --actor <current-admin-email> --id <existing-Kelpie-row-id> --apply
   ```

   The file contains the complete existing policy (`name,enabled,redirect_uris,scopes,
   methods,allow_registration,primary_color,background_color,text_color`). Preserve
   callbacks/providers/branding; use an existing row ID to update, never a migration
   seed or duplicate identifier. No icon argument means the current icon is preserved.
4. Scope policy edits increment the app revision and invalidate previous native client
   registrations and refresh families. Release clients register anew and show normal
   hosted sign-in once. A still-valid old token lacking scope gets403; stale registrations
   get401. Neither refresh nor ticket acquisition silently adds consent. After that
   one-time sign-in, restores and socket renewal are automatic with no pairing or team
   setup. Operators must coordinate the policy edit with the native release.
5. Deploy Nessie's live validation gateway and release/install native clients. Confirm
   ticket issue and domain-authenticated validation without logging tokens, then verify
   native logout/account disable closes the connection and prevents work. UOA deployment
   alone does not deploy any gateway or native app.

## Focused verification

With an isolated migrated database exported as `DATABASE_URL`, run
`pnpm --filter @uoa/api exec vitest run tests/integration/kelpie-connect.test.ts`
and the native account/refresh/app and confidential OAuth regressions. The focused
suite covers PKCE, unchanged refresh scope, profile-free claims, source expiry cap,
domain isolation, tampering/class/audience/expiry, scope narrowing, bans, epoch,
factor/lifecycle/app revocation, and disabled operator configuration. All test writes
use isolated schemas; an unset database skips integration tests and proves no database
coverage. Run Auth/Admin typecheck/lint and local headless Playwright for consent and
the Kelpie operator scope field. Browser tests stay out of CI.

Verified on Minis on 2026-10-11 using an isolated PostgreSQL database: the eight
connection integration tests, three policy unit tests, native account/refresh/app
regressions and twenty confidential exchange/resource validation regressions passed.
API, Auth and Admin typechecks/builds and changed-file lint passed. Local headless
Chrome passed the operator editor on desktop/mobile (four checks) and the native
consent screen on desktop/mobile (two checks); their screenshots were inspected.
Production operator provisioning, installed native clients and actual WSS revocation
remain integration/deployment checks; the HTTP tests do not prove those are live.

The subsequent gateway-rate regression passed on Minis against the same isolated
PostgreSQL database: all nine connection integration tests passed, including 121
consecutive domain-authenticated validations without consuming the native issuance
bucket. Changed route ESLint passed. This is server-side HTTP evidence, not live WSS
or production operator provisioning evidence.

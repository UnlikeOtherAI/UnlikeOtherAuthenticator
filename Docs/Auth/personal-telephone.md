# Personal telephone profile

UOA owns the number, pending claim, verification time and colleague visibility. Nessie's personal profile is the user-facing home. These UOA endpoints are machine-only: Nessie's signed-in backend reads and changes the owner's profile and delivers SMS. UOA does not call Twilio. Deploy this migration and API before enabling the Nessie relay.

## Enrollment

POST `/apps/v1/nessie/phone-profile/{read,set,start,verify,remove,visibility}` requires the Nessie `customer_lifecycle` `X-UOA-App-Key` and `X-UOA-Actor`. The registered RS256 actor has the exact endpoint URL as audience, signed-in `sub`/`tv`, `product: nessie`, exact organisation/team, issuer, key id, `jti`, `iat`, and at most 60 seconds lifetime. Legacy billing audiences are rejected. Active user, organisation and team membership and the current epoch/key are checked in the transaction.

Every body includes `product: "nessie"`, `organisation_id`, `team_id`, `user_id`. Additional fields:

| Action | Fields | Response |
| --- | --- | --- |
| read | none | `{phone}` |
| set | `number` | `{phone}` |
| start | `number` | `{challengeId,expiresAt,delivery:{number,code}}` |
| verify | UUID `challengeId`, six-digit string `code` | `{phone}` |
| remove | none | `{phone:null}` |
| visibility | `visibility: "private" | "team"` | `{phone}` |

`phone` is null or `{number,pendingNumber,verifiedAt,visibility}`. Numbers and verification time may be null; times are ISO strings. Numbers must be canonical E.164 (`+` and 7–15 digits, no leading zero). Responses are private/no-store. Unknown body fields are rejected.

`set` records a pending claim without SMS, preserves the existing verified number and invalidates outstanding challenges. It works before Nessie has a same-region SMS sender. `start` records its supplied pending number and issues a code when Nessie can deliver it.

The six-digit code in `delivery` is a backend delivery instruction. Nessie must send it through its approved SMS path and remove the entire `delivery` object from browser responses and logs. It must not persist profile copies. UOA stores only a keyed digest of the challenge code. Five starts per person and destination in 15 minutes and five guesses per challenge are allowed. Challenges expire in five minutes, bind the issuing app key and authentication epoch, and are invalidated by a new start or removal. Failed guesses commit their attempt count. A new start preserves the verified number and records the new pending claim. Successful verification replaces the number, clears the pending claim and defaults visibility to private.

Visibility controls disclosure to colleagues. It never controls routing to the owner. No colleague-directory endpoint is added by this change; an existing/future consuming directory must obtain permission-scoped data from UOA rather than copying this self response.

## Inbound routing

POST `/apps/v1/nessie/phone-profile/lookup` accepts only `{number}` with the same app key and `X-UOA-Service-Assertion`. It rejects `X-UOA-Actor`: a telephone caller has no signed-in user assertion.

The service assertion is signed by the registered actor key. Header: `alg: RS256`, registered `kid`, `typ: uoa-telephone-routing+jwt`. Its strict claims are:

```
iss, aud, purpose: "telephone-routing", product: "nessie",
organisation_id, team_id, call_id, number_digest, jti, iat, exp
```

`aud` is the exact public lookup URL; `iss` is the registered actor issuer. `number_digest` is lowercase SHA-256 hex of the canonical number. Maximum lifetime is 60 seconds. `sub`, `tv` and any extra claims are rejected. Nessie must validate Twilio's request before minting this assertion, derive the selected team from its own called-number assignment and use the provider call identifier. The assertion authenticates Nessie's request, never the caller.

The response is `{match,authentication:"none"}`:

- `null`: no live same-team claimed or verified number.
- `{state:"pending"}`: one pending claim, with no subject.
- `{state:"ambiguous"}`: multiple live claimants, with no subject.
- `{state:"verified",subject,verifiedAt}`: one verified profile, including private profiles.

Lookup rechecks active user, organisation and exact team membership on every request, including retries. It never returns visibility. A pending claim remains until removed, replaced or verified even after its challenge expires, allowing Nessie to give verification guidance. Multiple owners of a shared number fail closed as ambiguous; a pending claim cannot select another person's authority.

Nessie must treat all outcomes as unauthenticated. Verified caller ID is routing context only: spoofable caller ID and old SMS possession do not grant profile, conversation or tool authority. Nessie owns live-call proof before accessing authenticated context. Pending and ambiguous calls must stop before private context; unknown numbers may enter the public Clients intake.

## Storage and controls

`user_telephones` stores the verified and pending number. `telephone_challenges` stores bounded attempts and keyed code digests. `telephone_lookups` records app key, opaque call id, keyed request binding, matched boolean and creation time; it contains no number or subject. A call id cannot change number or team, and retries return fresh membership results. The durable limit is 120 new calls per minute per app key; an additional process limiter caps requests at 240/minute. These are service-wide ceilings, not a Twilio origin verifier.

All three tables deny the tenant database role and use the existing administrator data connection. Identity erasure deletes profile and challenge data; scheduled retention removes challenges after one day and routing audit rows after 30 days. The migration backfills no claims. Existing verification codes become invalid if `SHARED_SECRET` rotates; request-binding retries spanning that rotation are refused and must fail closed.

## Verification

Run the focused `personal-telephone.test.ts` integration suite with an isolated migrated PostgreSQL database, plus retention pruning unit coverage, API lint and typecheck. Fixtures use locally signed assertions and no SMS provider. Live SMS delivery and live telephone proof require the consuming Nessie release and are not established by UOA tests.

### Verification record — 2026-10-21

On Windows Maxis, revision `4a5cd4b9` passed the nine telephone integration cases and retention unit case (10 tests), using an isolated PostgreSQL 17 cluster on localhost port 55451 and a freshly migrated test schema. The seven actor-audience/route-registration tests passed separately. API typecheck passed after building the billing-statement-protocol and slug dependencies; lint passed for changed TypeScript files and the final integration fixture. The test database was stopped afterwards.

The isolated cluster needed `max_locks_per_transaction=256` for schema teardown; the initial default hit PostgreSQL's lock-table limit after all assertions passed. Running start, tests and stop in one SSH session avoids Windows terminating the test server between commands. No application workaround was added for either test-host condition.

Self-review checked the shared product-policy and user-epoch lock order, committed failed attempts, retained verified values during pending replacement, exact endpoint audiences, strict service claims without a user principal, fresh membership reads on retries, and tenant-role denial even with table SELECT grants. Shared-number claims intentionally return ambiguous rather than selecting an owner. UOA owns the data; the Nessie profile and SMS relay still need integration, and real SMS delivery and live-call proof remain unverified.

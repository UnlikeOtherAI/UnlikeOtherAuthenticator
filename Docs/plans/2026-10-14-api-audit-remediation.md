# API audit remediation — implementation and rollout

Parent master checklist: Nessie `docs/plans/2026-10-14-astra-audit-remediation.md`.
All boxes stay unchecked until integration and appropriate verification. Source
review is not runtime evidence. This branch is the API tranche, with no Auth/Admin
frontend writes. No production probes, credential use, rotation or deployment ran.

### Three-org profile scope correction — 2026-10-15

The strengthened real TCP/PostgreSQL test exposes a missing self-profile PATCH
invalidation for a legacy ownership reference without OrgMember. PATCH now uses
the same canonical complete membership-plus-ownership scope resolver as avatar
and credential epoch writes, after the exclusive user lock and before sorted org
locks. The failing schema and outbox remain retained. Runtime rerun is pending;
this correction does not authorize N03 or certify all113writers.

### Access assignment policy order correction — 2026-10-15

Actual PostgreSQL contention between configured access assignment and canonical
lifecycle writes exposes a user-before-policy deadlock. The access-assignment
entry now takes shared policy before shared user, followed by sorted directory
org locks. Its exported helper no longer depends on an outer auth caller having
already taken policy. Original failed schema
test_1792026835119_a39de205a04b4ea2886b97f681acbe0c remains retained; correction
requires a passing actual race rerun, not source guard approval alone.

## Dispositions

- [ ] U-01 — drafted stable ClientDomain ID, request-only credential consumers,
  authenticated legacy family conversion and explicit post-drain cleanup. Tests,
  rollout self-review and credential-value exclusion coverage pending.
- [ ] U-02 — drafted shared password-method check before identity reads.
- [ ] U-03 — drafted exact originating config URL and email-code enablement.
- [ ] U-04 — drafted native password bans/allowlists before factor effects.
- [ ] U-05 — drafted committed wrong-attempt outcome and guarded consumption.
- [ ] U-06 — drafted self-join role reset and suspended-membership refusal.
- [ ] U-07 — drafted exclusive delegation CRUD policy lock matching issuance.
- [ ] U-08 — drafted full canonical hostname/path identity in chained audiences.
- [ ] U-09 — drafted exact active membership after invite link; route keeps
  product-aware admission and rollback of unauthorized cross-product joins.
- [ ] U-10 — drafted real membership/account lifecycle status in Admin projection.
- [ ] U-11 — drafted lowercase active domain predicate; dashboard DTO consumes it.
- [ ] U-20 — drafted handler-completion bulkhead release and real-socket regression.
- [ ] U-22 — confirmed non-Stripe schedulers start with DB; draft deploy keeps a
  warm unthrottled instance independently of Stripe. Idle hosting cost increases.
- [ ] U-23 — corrected savepoint claims in RLS docs and tenant helper comment.
- [ ] U-24 — clarified historical/planned role/token profiles versus shipped contract.
- [ ] U-25 — fixed upstream PR #114/da1be8a0, parent integration40ce1133;
  awaiting incorporation and focused verification. Do not label falsified.
- [ ] U-26 — confirmed DB errors caught as invalid native account credentials;
  drafted narrow cryptographic catch preserving later dependency failures.
- [ ] U-27 — confirmed missing account throttle; drafted five failed authentication attempts per account
  per15minutes across IPs (successful MFA continuations do not consume the budget), using existing bounded per-instance limiter semantics.
- [ ] U-28 — source behavior matches explicit domain-authored capability contract
  (brief24.1a/c and Sept30 parity amendment). No change to grants. Trust-contract
  review remains visible; a different operator boundary requires an explicit amendment.
- [ ] U-29 — confirmed policy built before shared lock; drafted registered-client
  revision/method/callback reread before factor enrollment or challenge effects.
- [ ] U-30 — confirmed ignored config quotas and team suspension lift; drafted
  member/team/user caps, role vocabulary, fresh lock-time expiry and suspension refusal.
- [ ] U-35 — drafted exact online Admin bearer digest revocation; verification and
  usability review pending. Previous behavior: family logout revokes refresh/debug grants,
  while a captured admin access bearer remains valid to expiry absent global epoch.
  Do not silently require a cookie for every admin API or revoke sibling sessions.
- [ ] U3 — drafted self profile/pronouns and exact authorized display/image routes;
  additive schema, exact erasure provenance and ordered invalidations drafted.
  Focused authority checks pass; HTTP/RLS/upgrade/consumer verification remains pending.
- [ ] U1 — drafted separate expiring/rotating directory credentials, current-owner
  exact-org grants and live standing/display/image reads. Ordered invalidation
  outbox, terminal revisions and writer integration are drafted; runtime acceptance
  and the consuming delivery contract remain pending, so do not cut over cached readers. No directory fallback or durable product identity mirror is acceptable.

Translation body timeout (U-21) belongs to frontend/translation owner: the timer
must cover response body consumption, not end at response headers. Source showed
clearTimeout before response.json; no duplicate edit here.

## Human-flow and compatibility review

Password/social/native: enabled existing methods retain their continuations,
PKCE, credential epoch, lifecycle, strongest-wins MFA and signatures. Disabled
password/code routes are refused generically. Codes issued for another client
cannot authenticate this client; requesting a new code is the supported recovery.
The wrong-attempt cap is durable; network errors must not become a logout.

Membership: a removed administrator self-joining receives member, never the old
role. A suspended member needs explicit administrator reactivation. Valid
cross-product invite links remain usable with current product-aware policy;
unknown products do not gain cross-product team admission. Limits apply to new
seats, not an idempotent already-active membership. Existing sessions are not
revived. Admin presents real disabled/removed status instead of fabricated active.

Concurrency: disconnect keeps work counted until its service handler finishes;
queued disconnected requests are removed. Sign-in paths remain outside the data
bulkhead. Delegation revocation waits for in-flight locked signing; already-issued
bounded JWT behavior stays as documented.

## U-01 staged deployment and rotation

1. Run synthetic migration/replay/revocation tests and inspect all context consumers.
   Ship API compatibility readers and stable-ID writers first. No startup data
   rewrite runs while older revisions still need bearer-bound client contexts.
2. Use a controlled retryable503 ingress gate for token/refresh/debug operations,
   drain older revisions through their maximum request/transaction timeout, then
   route traffic exclusively to the verified new revision and release the gate.
   Do not mix old and new readers while converting shared refresh families.
   In-flight legacy writes remain readable by the new authenticated compatibility
   path. Healthy renewable sessions keep their family, epoch, scope and MFA proof.
3. With protected environment variables DATABASE_ADMIN_URL and SHARED_SECRET,
   run `pnpm --filter @uoa/api exec tsx src/cli/migrate-website-client-context.ts --dry-run`.
   Only counts are printed. Review the target via approved operational evidence;
   never print credentials or DSNs. Apply with `--apply-after-old-revisions-drained`.
   It verifies legacy credential validity under policy/session locks, migrates
   valid families and debug grants together, and retires unusable bindings without
   deleting history or restoring authority. Retry is safe. No grant/scope widening.
4. Audit legacy raw contexts are gone and inspect restricted logs/backups under
   retention policy. Decoded JWTs and expired JWTs cannot be recalled. For every
   potentially exposed domain, generate/install a new backend secret through the
   existing operator path, verify the deployment, then revoke all exposed old
   secrets. Never use the exposed bearer as an exploit probe. Products retain
   valid refresh families through stable-ID context; current backend authentication
   still requires an active secret. A revoked pre-cutover binding is retired.
5. Retain the new compatibility-capable revision as rollback target. Rolling back
   to bearer-context writers/readers after conversion is unsafe. Roll forward on
   failure; do not restore credential values or delete sessions to conceal it.

No production cleanup/rotation is authorized by running this implementation.

## Validation so far

Maxis: locked dependency installation and Prisma generation completed. Prior
one-worker focused run:52passed,5failed, seven failed files/two passed files.
Fixtures for code enablement/config URL, domain status and role reset were updated;
workspace package build prerequisites and remaining failure diagnostics await the
allocated heavy compiler slot. No PostgreSQL reproduction or deployment ran.


## U3 and U1 contract handoff

U3 routes are in `API/src/routes/root/schema.profile.ts`. Exact self GET includes
current email; PATCH accepts name and pronouns only. No email-change API exists
in current source and none is invented here. Email must remain read-only until a
separate verified protocol is implemented. Other-user display never returns email.
All images use the same authenticated context, including cross-product members
without a local domain-role shortcut. Older domain-only deletion references are
not backfilled into per-org permission; unproven/erased authors return generic404
for neutral presentation. New retained deletions capture exact prior org IDs,
while erase-reference deletes those grants and pronouns are scrubbed.

U1 direct routes are in `schema.directory.ts`. Secrets issue once to a backend
and never enter query cache/browser storage. Only current canonical org owners
may explicitly grant MEMBERSHIP_READ/DISPLAY_READ/WEBHOOK_MANAGE; admin-like custom
roles cannot grant product standing. Rotation preserves grants but bounds old
secret overlap to ten minutes. Revocation/domain disable/expiry are checked on
every read under the policy fence. Live standing has no email/profile fields;
permitted display is minimal and memory-only. No snapshot revision is fabricated.
Outbox and U2 delivery remain required before the consumer's cached authority cutover.

The remaining outbox seam must resolve affected org IDs before the first mutation,
take sorted per-org transaction locks, commit minimal invalidations/revision with
the mutation and hold locks through commit. Merely publishing after service return,
using timestamps, or adding row-trigger locks in arbitrary order is insufficient.
The targeted writer inventory currently finds60non-create mutations across auth
recovery, social login, profile/avatar, organisation/member/team/invite lifecycle,
first-placement/admin additions and entity deletion. Create/nested-create/upsert
paths must also be covered; this is inventory, not completed verification.


### Ordered outbox foundation checkpoint (not complete writer coverage)

`directory-mutation.service.ts` locks the complete declared org set in sorted
order before its callback, allocates each revision under those locks, and writes
ID-only events in the same transaction. Revisions and terminal events deliberately
have no org FK, so physical deletion cannot erase invalidation evidence. Nested
writers cannot extend an already-declared set midway through a transaction.
Profile PATCH now uses this seam after canonical user/policy locks and before
team-scope row locks. No delta/snapshot/cached-authority cutover is exposed yet.
All org/team/member/invite/automatic-enrolment/avatar/lifecycle writers still need
explicit integration and a complete coverage audit; this foundation does not
certify U1. Tenant-role writer integration also needs an explicit RLS-safe storage
boundary: the new outbox tables currently deny direct app-role access.

Focused lint passed on drafted changed tracked TypeScript files; Prisma schema
validation passed with a synthetic unreachable URL (no DB connection). New real
PostgreSQL seam tests cover rollback, waiting on the actual advisory lock,
concurrent commit order, reversed multi-org input and terminal evidence. They
have not run because the heavy compiler/server/database slot is not allocated.
Directory credential unit fixtures cover purpose separation, one-time secrets,
exact-org permissions, live revocation, dependency failures and bounded rotation.
Native throttling now reserves in-flight account attempts as well as retaining
failed guesses; successful MFA continuations release the reservation. This closes
the parallel-IP gap without charging each successful continuation as a failure.


### Canonical writer integration in progress

The next draft connects the seam to direct org add/role/remove,
org deactivate/reactivate, ownership transfer, team add/role/remove/self-join,
team create/update, org update and team-group assignment. User/session locks
remain before org ordering locks; container/membership row locks follow them.
`20261014150000_directory_outbox_tenant_boundary` adds a schema-pinned definer
function that checks resolved tenant/org or explicit domain-backend/new-owner
context before recording an invalidation. It revokes PUBLIC execution and leaves
all direct app-role table access denied. Admin terminal deletion uses the existing
BYPASSRLS authority. Runtime tenant-role proof is still pending.

Invitations, automatic placement/enrolment, new org creation, lifecycle/deletion,
profile/avatar/social and credential-epoch writers remain under audit. Do not
consider a writer family complete from this partial list. No cache contract ships
until every writer and migration/rollback/concurrency test has been verified.
Bulkhead tracking now also encloses route preValidation/preHandler async work;
an early reply cannot release its slot while that phase remains running.


Invitation/link redemption now uses the ordered seam. Invite acceptance resolves
all prior orgs before its optional name fill and includes the target membership
change, so a name update is not published only to the invited org. Direct org
admission now takes the target's canonical user lock before the org seam, keeping
multi-org profile scope discovery stable against admission. Link validity/expiry
is checked again after ordering and membership lock waits, before consumption.
The real-DB seam fixture also sets the existing app role locally in a disposable
schema: exact context may record, sibling context must fail, direct outbox reads
remain empty under RLS. No shared role password/attribute is changed by that test.
All these runtime tests remain unexecuted pending the allocated heavy slot.


New-org creation (interactive and operator), automatic mapped placement and
personal first-team creation now declare the org ID before mutation and enter
the ordering seam. Admission takes shared canonical user locks, which pin scope
discovery against exclusive profile changes without upgrading an already-shared
credential lock. Placement uses canonical-user before placement before org locks.
Creation IDs remain opaque strings. Fresh runtime tests must verify the explicit
ID fixtures and every first-placement flow before this draft is integrated.
The remote integration branch was fetched after checkpointing; no newer commits
were present. Heavy tests/typecheck/build and new server/database work remain
unstarted because the API slot has not been allocated.


### Server-free focused validation

Maxis single-worker `vitest --config vitest.light.config.ts`: 46 passed across
6 files (15 login-code,16 profile authority,6 directory credential,4 legacy context,
3 native failure-budget,2 exact admin-bearer revocation tests). No setup server,
network listener, database or workspace build ran. The initial limiter import
exposed an unnecessary dependency on the org middleware/service graph; extracting
pure bearer syntax into a utility preserved the guard export and made these
checks independent of missing workspace dist. Full default-harness/HTTP and
PostgreSQL suites, generated schema client, typecheck and builds remain pending.
The profile specification now explicitly documents the missing email-change API,
neutral inactive labels and BFF-proxied authenticated images.


### Composed profile/admission checkpoint

`directory-user-mutation.service.ts` resolves membership and owner org references
under the exclusive canonical user lock. Avatar upload/delete, existing-social
profile writes and credential-epoch bumps now emit org-scoped invalidations.
Team avatar changes use the exact team org seam. Verified email name fills use
the same profile boundary, with the verified invitation's org declared up front.

Composed social callbacks predeclare their verified invite org and configured
access-request target. When first-team creation is possible, an internal plan
reserves one opaque new-org ID before the profile write; creation reuses it.
No revision/event is fabricated for an unused planned org. Nested operations can
reuse this complete sorted set; an undeclared extension is refused before its
write. Social new-user placement now receives the supplied transaction rather
than checking out another pool connection.

Access-request admission is transactional, takes shared user then org ordering
locks, rechecks current lifecycle, counts ACTIVE seats and refuses inactive
membership rows rather than approving an unusable hidden membership. Operator
member additions and org/team policy edits now emit invalidations. Policy edits
fence auth readers before acquiring directory ordering locks.

Maxis server-free single-worker suite:49 passed across7 files, including composed
scope/creation planning. Focused lint and source syntax/file-size checks pass.
Real transaction ordering/RLS/upgrade tests and complete auth flows remain pending
allocation; lifecycle/deletion and the final actual-writer coverage audit remain
implementation work. No checkbox is promoted to verified completion.


### Lock-order and terminal-stream checkpoint

Mutation roots now take shared product policy before canonical user locks;
operator policy writes retain exclusive policy first. Multi-user membership
operations pin the complete actor/target set in sorted order (exclusive mode for
the revoked target, shared for other pinned users), before domain/org ordering
and membership-row locks. Password/2FA recovery roots take policy before user,
not while already holding the user lock. Refresh predeclares all potentially
revoked user orgs before its policy guards take membership rows. This serializes
same-org refresh mutation decisions with directory writers; latency/contention
must be measured in the real runtime checks rather than assumed negligible.

The terminal-cursor migration makes organisation.deleted the final event in its
stream, including later user cleanup. Subject-indexed outbox storage supports
bounded-index lookups for erasure without scanning every event. The PostgreSQL
fixture now checks no profile invalidation follows a terminal deletion; it is
still unexecuted. Shareable-link lookup/redemption were split into focused
modules to retain the project's 500-line rule while preserving facade exports.

Maxis server-free checks:50passed across7files. The additional fixture checks
sorted mixed actor/target user locks and their shared/exclusive mode. Source
syntax/size checks passed for23 changed TypeScript files. This does not certify
actual lock ordering, migration SQL or full auth-flow behavior; those require
the allocated PostgreSQL/default-harness slot. Lifecycle/deletion integration
and final source-writer audit remain open.


### Lifecycle/erasure and source acceptance checkpoint

`directory-lifecycle-mutation.service.ts` now plans lifecycle and terminal cleanup
invalidations, including exact retained history, previous outbox subject scopes
and org/team allowlist-only scopes discovered before erasure. Final erasure
scrubs previous outbox subjects and emits org-only facts, so a policy-only org
cannot learn a deleted nonmember subject. Deleted/absent orgs are never reopened
as legacy streams. Scope cleanup captures only real prior org membership rows
before removing them; later account cleanup retains that provenance in retain
mode. Organisation grants are removed before physical org deletion.

Lifecycle transition/start, bounded deletion stages and group CRUD/member changes
are integrated into the draft seam. Audit completion is committed as a cursor;
only the next final identity-erasure stage takes exclusive product policy before
actor/user locks, because that stage edits live allowlists. Other bounded stages
use shared policy and permit auth readers. Final allowlist-query timing and retry
behavior must be measured in real PostgreSQL fixtures before integration.

The [canonical writer ledger](2026-10-14-api-directory-writers.md) records113
Prisma writes across52 functions plus the raw three-table allowlist loop. A
source guard checks seam ancestry/private callers and reviewed field exceptions;
it is not runtime/order/authorization proof. The request-only domain credential
and subject assertion header were added to structured log redaction. Operator
directory metadata is bounded to200 credentials and2 recent secret records each.

Server-free Maxis utility run:72passed across10files, plus the new writer-coverage
guard passed separately. Real-RS256 native-account fixtures preserve DB/key/config
outages as server failures while refusing bad signatures, claims, revoked clients
and missing scope. Mounted audience construction has13 focused cases. The broad
chained suite initially failed import before workspace dist existed; source-only
checks now use the actual workspace TS, not compiled exports. The6 source-only
service files passed81 cases, and updated password/self-join regressions passed13
cases after adding suspension/default-role/method tests. A combined fresh count
and all full compiled/default-harness/DB/rendered checks remain to be recorded.
No new server, database, workspace build or production operation ran.


Fresh checkpoint validation on Maxis: server-free light suite73/73 across11files;
source-only service suite84/84 across6files. Both use one worker and no listener,
global database checkout or workspace build. All89 changed TypeScript files pass
syntax/500-line checks; focused lint and Prisma schema validation pass. These
results replace the earlier52pass/5fail unit result for the exercised service
areas, while compiled package exports, generated client/typecheck, full default
harness, real PostgreSQL/upgrade/races and rendered flows remain pending allocation.

### Post-integration member-state contract checkpoint

Merged origin/fix/sol-audit-integration-20261014 at22f9634a after pushing the
API checkpoint; additive architecture conflicts retain both complete sections.
No API implementation was discarded. Offline dependency metadata installation
used frozen lockfile and disabled lifecycle scripts; no package build ran.

U-10 API projection now preserves account lifecycle in `members[].status` and
exposes independent `membershipStatus` (active/deactivated/removed). This avoids
masking a banned/disabled account behind a removed membership and preserves the
existing account-status DTO contract. Root endpoint schema and LLM docs describe
both. Seven formatter cases pass. Frontend handoff remains: add membershipStatus
to OrganisationMember and render it in the existing organisation member table,
which currently does not show membership state. No Admin UI was changed here;
operator-visible acceptance remains unchecked until that consumer work is tested.

Fresh post-merge Maxis server-free checks: light73/73 across11files and source
services91/91 across7files (164 total). No listeners, DB, generated-client update,
workspace builds or production operations. Heavy/compiler slot remains unallocated.

### Refresh and native admission request regression checkpoint

Expanded the source-only single-worker harness to existing refresh rotation,
replay, binding, global/domain/membership revocation and verification epoch suites.
The first expanded run had16 failures:15 fixtures lacked the required directory
scope store and1 native fixture omitted current client scopes/policy dependencies.
Updated injected stores explicitly; production authority/outbox checks stay intact.
Global revocation now asserts the same transaction records the exact org/subject
credential epoch event after the version write and before commit. The refresh
suite's corruption, response-loss and post-grace theft behavior remains exercised.

Native route fixtures now include7 additional Fastify.inject regressions: client
removal, revision change, callback removal, current disabled password method,
allowlist refusal, ban refusal and in-transaction dependency outage. Password/MFA
effects are absent when current client policy refuses; bans/allowlists stop MFA
and signing, and dependency outages retain500. No network listener is opened.
These are injected order/refusal checks, not a real concurrent native-app-edit test.

### U1 current-owner and live-standing regression checkpoint

Added13 server-free current-owner grant cases using the actual profile/domain
secret/epoch checks and injected stores: exact permission/audit writes, mismatched
org claims, changed owner, non-owner role, suspended/removed membership, inactive
org/account, stale epoch, expired actor, revoked/expired credential and idempotent
revocation. Added12 live-standing/display cases: minimal inactive results, exact
active teams/epoch, bounded overflow refusal, expiry after the subject-lock boundary,
dependency errors preserved, separate display permission and shared neutral former
member projection. No authority service is replaced with a test bypass. Synthetic
DATABASE_URL only enables the real injected-store path; no connection occurs.

Latest expanded source suite147/147 across16files passed on Maxis. This includes
the additional7 native request regressions. Real PostgreSQL and compiled export
checks still await allocation; U1/U3 acceptance remains unchecked.

### U3/U1 request cache and authority checkpoint

Added15 profile HTTP and10 directory HTTP Fastify.inject cases using the production
error handler. The profile harness verifies actual HS256 user JWT, live domain
bearer and epoch with injected stores; verified config fetching is seeded, and
image bytes are synthetic. Coverage includes current own email rather than JWT
profile, partial edits, unsupported edits, missing/blank/conflicting credentials,
stale epoch/inactive self, neutral removed-target display and credentialed image
reads. Directory coverage exercises actual separate purpose credentials and
permissions, inactive/refused/unknown authority, immediate image grant revocation,
neutral removed displays and dependency-error preservation. No listener/DB.

Usability/cache review found route cache headers were applied only after service
success. Both route families now set private/no-store in onRequest before auth,
including401/403/404/400/500. Schema slices/root registration and LLM docs match.
Source harness also maps the new shared auth-ui-strings package to actual TS
source so the production error handler can run without a workspace build; its
compiled package export remains unverified until the heavy slot is allocated.

Latest complete light suite98/98 across13files passed on Maxis. Combined with
the last source147/147 and25 new request cases,270 scoped cases are exercised;
a fresh complete source run is recorded with this checkpoint.

### JWKS recovery and invite-admission regression checkpoint

U-25 upstream implementation is incorporated. Added the existing13 actual-RS256
subject assertion outage/recovery cases and10 JWKS URL/fetch checks to the
server-free source harness: transient DNS/HTTP/transport503s retry freshly after
recovery; unknown/private destinations, wrong signatures/audiences and unknown
keys remain refused. The normal harness synthetic documentation-domain DNS and
undici-to-stubbed-fetch seams are supplied separately without its JWKS listener.
Unexpected DNS destinations throw rather than perform a real lookup.

The existing18 invite-link service cases and12 added admission regressions pass.
The cross-product fixture now pairs the caller domain with that caller's verified
config, preserving exact link/org membership without a false origin-domain gate.
New cases cover existing-role/idempotent admission, organisation suspension/removal,
team suspension, fresh-role reactivation, org/team/user limits, forbidden link
roles, expiry after locks, and exact ACTIVE lifecycle/membership query predicates.
These injected stores do not certify transaction rollback or cross-user capacity
races; the real PostgreSQL fixtures remain required.

Latest source suite has225 cases across23files; light suite98 cases across13files.
All323 scoped checks run on Maxis without a listener, DB or workspace build.
Full client generation/typecheck/build/default harness, migration upgrade/RLS/lock
races, real socket bulkhead tests and rendered product flows remain blocked on
the still-unallocated heavy slot. This is a checkpoint, not completed acceptance.

### U01 corrected two-phase rollout — supersedes prior online-conversion instructions

The earlier online migration draft was unsafe while pre-bridge readers could
still serve requests. Exchange, revoke and debug request paths no longer call
the family converter. WEBSITE_CLIENT_CONTEXT_PHASE defaults to bridge. During
bridge, newly issued website refresh families use the authenticated request-only
domain credential solely as the old storage binding; rotation/replay/debug preserve
that family context. Public JWTs still use the stable ClientDomain id and never
contain the bearer. Native OAuth refresh bindings remain unchanged. Temporary old
storage remains confidential and is not claimed remediated until final cleanup.

Operator sequence (not executed by this run):
1. Deploy the reviewed bridge build with explicit WEBSITE_CLIENT_CONTEXT_PHASE=bridge
   everywhere. Keep this phase until every pre-bridge revision is retired/drained.
   Verify mixed old/new rotation, replay, exact config and debug behavior. This
   phase must precede stable writers; do not deploy stable directly from pre-bridge.
2. Switch the repository deployment variable to stable and deploy reviewed stable
   writers. Bridge readers can read stable families during this rollout. Stable
   readers return retryable503 for legacy families until cleanup; do not translate
   that outage into logout. Retire/drain ALL retained bridge/pre-bridge revisions,
   including zero-traffic/tagged revisions, through the ordinary provider workflow.
3. The CLI apply now REQUIRES WEBSITE_CLIENT_CONTEXT_PHASE=stable plus explicit
   --project=<id> --region=<region> --service=<name> and one or more
   --compatible-image=sha256:<reviewed stable image digest> arguments. It directly
   queries Cloud Run revisions through gcloud (captured output is never logged),
   refuses empty/unavailable inventory, unmarked/unreviewed/deleting revisions,
   and any retained bridge writer. A caller-supplied inventory/acknowledgement is
   insufficient. Only then may it migrate under policy/user locks. Dry-run remains
   count-only and does not permit conversion. Do not print DSNs/credentials.
4. Audit no legacy bindings remain; keep stable phase for future deployments.
   Rollback targets must be reviewed stable/bridge-capable readers; never resurrect
   a pre-bridge revision or legacy secret fields. Secret rotation is a separate
   operator operation and was not performed here.

Eleven light regressions exercise old exact readers against bridge issuance and
rotation, new readers against legacy families, replay and revoke without family
rewrites, config/domain/revocation refusal, stable503 gating and strict revision
inventory rejection. Actual rollout/provider verification remains an operator
acceptance step; this run never called Cloud Run or changed any live deployment.

### First allocated runtime gate and follow-up fixtures

Atfa539978 Maxis serial builds of slug/billing-protocol/auth-strings, Prisma
validate/generate, API build and all3 compiled imports pass. The owned512MiB
Fedora PostgreSQL16 instance on55460 applies all206 migrations cleanly. Protected
55440/55445 instances are unchanged. Durable sanitized stdout is in
`Docs/audit-evidence/2026-10-14-api/fa539978`. First runtime gate60pass/1fail:
17 signed capability route cases and3 Admin debug/logout cases pass, as do37
bulkhead middleware cases and3 directory order/rollback/terminal tests. The
directory RLS case failed fixture setup by omitting the required ACTIVE-org owner.
The fixture is corrected with a real owner, preserving the production constraint.
No API compiler/test children remained before the source correction.

U01 bridge storage now normalizes an uppercase authenticated bearer to the same
lowercase legacy format that old readers expect. Added a focused regression.
U1 provisioning is explicitly machine-only, documented at
`Docs/Auth/directory-provisioning.md`, exposed in root machine/LLM contracts and
exercised through real operator/owner HTTP in the new PostgreSQL fixture.

The new unexecuted profile/directory fixture connects as real uoa_app and uoa_admin
roles; checks scoped RLS/rollback, canonical self writes/outbox, nullable/historical
displays and actual authenticated image bytes, signed credential refusal, observed
PostgreSQL lock waits with expiry, credential revocation serialization and real
permission failure as500. Failed fixture schemas are retained for diagnosis.
The next gate must execute these and the distinct real-socket bulkhead route
fixture; source AST or middleware unit checks cannot substitute for them.

### Verified U1/U3 boundary and pre-stable deployment guard

At7dac9a3f API build and all23 runtime gate2 cases pass:11 actual HTTP/PostgreSQL
authority cases,4 directory seam/RLS/order/terminal cases and8 genuine-socket
bulkhead route cases. Exact sanitized output is in the corresponding evidence
folder. This verifies the supported machine-only operator/owner doorway with real
uoa_app login/RLS, not a superuser-only approximation. Full113-writer and upgrade
coverage still remains open; N03 stays blocked.

U01 stable writes also need the reader floor BEFORE deployment, not merely before
conversion. The deployment source now refuses stable mode unless direct Cloud Run
inventory has only reviewed bridge/stable image digests with explicit phase markers,
including every tagged/zero-traffic retained revision, and no retiring revision.
Repository variable WEBSITE_CLIENT_CONTEXT_COMPATIBLE_IMAGE_DIGESTS is a comma
list of operator-reviewed immutable sha256 digests. Missing/empty/unknown inventory
or missing/duplicate phase metadata fails closed. Bridge deploys require no floor
so the compatible first phase can roll out. Final cleanup remains stricter: all
retained writers must be stable. No live GitHub variable, deployment or traffic
gate was changed by this source edit.

### Default-unit fixture corrections (in progress)

The b95098a6 full default gate is retained as2586pass/75fail/3skip, not described
as green. Focused fixture corrections now use stable client IDs, explicit current
user directory scope delegates, online Admin revocation stores and canonical
lifecycle reads. Unbound factor/profile fixtures are named as unbound; real bound
writer acceptance continues to use PostgreSQL. Transaction fakes now provide a
fresh object without $transaction, matching Prisma and preventing a false retained
directory plan across requests. This fixes the chooser second-org500 rather than
relaxing the complete-scope guard. Native global-limit coverage explicitly includes
the new OAuth limiter and distinguishes its reservation helper from middleware.

The existing provisioning guard also caught this branch's shorter beforeAll
timeout; it now inherits the normal180second budget. The source-only harness uses
the same30second test budget as the default harness so cold import of createApp
does not cause a spurious5second failure. Existing oversized group/social test
files were split with all13 group and10 social cases preserved; touched code stays
under500lines. These changes do not weaken production authorization/outbox paths.
Auth HTML/CSP checks still need the actual Auth dist/SSR build before the complete
default gate can be rerun. Full writer-family/upgrade/race acceptance stays open.

### 2026-10-15 complete default unit gate

At source 5de6df8c on Maxis: Auth assets/SSR build passes; normal serial API
unit/source gate passes all 397 files, 2661 tests, with 3 skipped (2664 total),
exit 0. Sanitized stdout: `Docs/audit-evidence/2026-10-15-api/5de6df8c/`.
This resolves the previous 75 failures, without weakening production guards.
Runtime writer/upgrade acceptance remains unchecked and N03 remains blocked.

### 2026-10-15 retained PostgreSQL failures and correction

Gate3 at ec856936: lifecycle14pass, then the 25-member/250-audit-row case fails
inside the unchanged15-second begin-deletion transaction. Schema retained;
no failed/stuck record cleared. Gate4: native refresh9, native sign-in11,
native account5 and shared reader/exclusive epoch-writer1 pass on real PG.
Upgrade fixture failed before DB creation because its pinned1.65MB Git archive
exceeded Node's default1MiB stdout buffer; corrected to a bounded4MiB buffer.

The deletion correction resolves the complete candidate lock set first, then
runs the full eligibility/billing preview once under the existing locks. Read-only
EXISTS/UNION queries consolidate dependency checks; product-domain discovery is
batched. Refusal reasons and their order, exact locks and15-second production
transaction budget are preserved. Added real-PG lifecycle/dependency/financial
refusal regression cases. New source is not yet runtime-accepted.

### Retained lifecycle continuation

The corrected begin-deletion path now passes its unchanged15-second transaction
budget. The full26-subject/250-audit staged cleanup exceeded its separate60-second
end-to-end test budget;14 other lifecycle cases passed. The scale test now has a
240-second end-to-end allowance; production stage/transaction budgets are unchanged.
The retained schema `test_1792021505371_8ccd14845ee54fb7992a1ed98ebde59b`
contains the original READY job with8/26 users completed and its natural lease.
An explicit owned-database recovery test resumes it through executeEntityDeletion
only, waiting for lease expiry and checking immutable terminal cursor/250audit rows.
No record, lease, progress or blocker is cleared by the harness.

### 2026-10-15 lifecycle and dependency runtime acceptance

Source1391d4d0: retained original job recovers via six normal service attempts
(93.85s), preserving250audit rows and its unchanged terminal cursor. The complete
lifecycle regression then passes19cases, plus5realPG dependency refusals and the
source guard (25total,357.97s). The scale case completes in155.313s with its explicit
240s end-to-end allowance; production transaction/stage budgets remain15s.
Evidence: `Docs/audit-evidence/2026-10-15-api/1391d4d0/`.
This closes the observed lifecycle failures; full113-writer runtime coverage and
remaining authority races are still open. N03 cutover is not authorized.

### 2026-10-15 U01 actual mixed-version PostgreSQL gate

Sourcef1d1a448:5actual old/current reader cases plus12rollout tests pass (17total).
Actual pre-audit source0bd21cb7 rotates/replays bridge-written rows with current
API routes. Debug grants/independent families and revoke retain legacy context.
Stable-mode legacy503, old refusal of stable rows, reviewed bridge compatibility,
exact config/domain mismatch and revoked pairing all pass without conversion or
wrong-context consumption. No old server/build or production operation occurred.
Evidence: `Docs/audit-evidence/2026-10-15-api/f1d1a448/`; executable deployment
preflight floor10cases previously passed atb95098a6. Real rollout still requires
that documented/provider-verified reader floor; no live gate/secret changed here.

### 2026-10-15 literal TCP profile/directory authority gate

At832c4eca all6new TCP/PG tests pass: actualRS256 same-host JWKS self reads/PATCH,
canonical email/read-only refusal/no duplicate user row, actual multipart/avatar
bytes, nullableACTIVE display and exact historical/erased references, user/directory
expiry after observed PG lock waits, supported operator+exact owner provisioning,
independent permissions and actual authority-store outage500/no-store.
Real uoa_app is asserted non-BYPASSRLS; runtime uses uoa_app/uoa_admin clients.
Evidence: `Docs/audit-evidence/2026-10-15-api/832c4eca/`. Earlier injected-route
HTTP/PG evidence remains separate. All6pass, exit0; listener closed, schema retained.
Full113-writer/race coverage and N03 cutover remain open.

### 2026-10-15 actual group writer race and forward data repair

Gatecb7e0697 passes global profile/avatar/epoch invalidation across two orgs,
all7group writers' ordered outbox commits through uoa_app, and RLS rollback.
It then proves a real bug: group insertion commits after observed user-lock wait
and successful org removal. Failed schema retained:
`test_1792022987278_ecd28b77699643bcaf38219a0da3e472`.

Correction: post-lock boolean SQL admission and a narrow database insert/key-change
guard; current exact org membership, nonterminal subject and ACTIVE parent are
rechecked. Cross-origin identities use the same canonical UOA store. Missing
context is false, not privileged. Migration207 repairs orphaned/REMOVED group grants
with policy/user/org ordering and atomic outbox events. Existing DEACTIVATED
metadata remains intact. New fresh200->207 and retained-failure forward-migration
proofs are pending. Original113direct Prisma writer inventory remains unchanged;
SQL migration repair is additional, separately runtime-audited work.
/api and /llm now publish all7existing internal group write routes and admission
semantics. No frontend, production credential or live deployment gate changed.

### Group race and original-record repair verified

c6c1e366 API build and13group units pass; fresh200->207 migration passes with
orphan/REMOVED repair events, retained DEACTIVATED metadata and old-writer refusal.
d540e4f5's7real RLS/TCP writer cases pass, including observed removal race,
cross-origin subject admission, missing/sibling tenant confinement, terminal
subject refusal and permission-outage rollback. Original retained failing schema
then upgrades normally at73338de9:1invalid grant repaired with its old events
preserved and a new repair event; second migrate deploy idempotent. No manual
record/job/lease reset. See corresponding `Docs/audit-evidence/2026-10-15-api/`
folders. This closes the observed group defect, not full113-writer acceptance.

### Complete unit gate after group repair and focused authority races

At76790e42 complete normal API unit/source run passes397files,2661tests,3skipped,
exit0(242.31s). Prior75failures remain resolved after the group admission/migration
correction. At a2ac1103 all21real PG races pass across refresh replay10,
membership/token4, credential reset/code/continuation4 and ClientDomain disable3.
Evidence is in each source-named `Docs/audit-evidence/2026-10-15-api/` folder.
Remaining writer-family/runtime aggregate coverage is still open; N03 stays blocked.

### 2026-10-15 first-placement upgrade deadlock

The9-file admission/factor gate passes9cases (email first placement race/rollback3,
email verification5, social exact-team token binding1), then finds real PG40P01
between shared canonical user and exclusive placement locks. Failure schema retained:
`test_1792025161536_729754c053794de1b45822462b3e0861`.

Placement now takes the exclusive canonical user key before its placement key,
matching subsequent code issuance/canonical mutation; it never upgrades shared-user
while another product waits on placement. Existing route callers already take the
exclusive authentication epoch lock. The regression observes the actual exclusive
user-lock waiter. Its optional owned-schema mode retries the original user/products
through normal authorization/exchange, without seeding, clearing or deleting them.
This source correction is checkpointed but not yet runtime-accepted.

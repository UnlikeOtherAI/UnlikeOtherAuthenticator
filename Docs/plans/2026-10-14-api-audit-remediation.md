# API audit remediation — implementation and rollout

Parent master checklist: Nessie `docs/plans/2026-10-14-astra-audit-remediation.md`.
All boxes stay unchecked until integration and appropriate verification. Source
review is not runtime evidence. This branch is the API tranche, with no Auth/Admin
frontend writes. No production probes, credential use, rotation or deployment ran.

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
  additive schema and erasure coverage drafted. Tests and ordered invalidations pending.
- [ ] U1 — drafted separate expiring/rotating directory credentials, current-owner
  exact-org grants and live standing/display/image reads. Ordered invalidation
  outbox and full writer seam remain unimplemented; do not cut over cached readers. No directory fallback or durable product identity mirror is acceptable.

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

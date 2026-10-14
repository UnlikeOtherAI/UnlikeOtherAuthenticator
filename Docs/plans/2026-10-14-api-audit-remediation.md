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
- [ ] U-27 — confirmed missing account throttle; drafted five guesses per account
  per15minutes across IPs, using existing bounded per-instance limiter semantics.
- [ ] U-28 — source behavior matches explicit domain-authored capability contract
  (brief24.1a/c and Sept30 parity amendment). No change to grants. Trust-contract
  review remains visible; a different operator boundary requires an explicit amendment.
- [ ] U-29 — confirmed policy built before shared lock; drafted registered-client
  revision/method/callback reread before factor enrollment or challenge effects.
- [ ] U-30 — confirmed ignored config quotas and team suspension lift; drafted
  member/team/user caps, role vocabulary, fresh lock-time expiry and suspension refusal.
- [ ] U-35 — unresolved contract review: family logout revokes refresh/debug grants,
  while a captured admin access bearer remains valid to expiry absent global epoch.
  Do not silently require a cookie for every admin API or revoke sibling sessions.
- [ ] U3 — accepted self profile + exact authorized display contract; not implemented.
- [ ] U1 — required purpose-bound background grants and ordered invalidation outbox;
  not implemented. No directory fallback or durable product identity mirror is acceptable.

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
2. Route all new traffic to the verified new revision; drain older revisions.
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

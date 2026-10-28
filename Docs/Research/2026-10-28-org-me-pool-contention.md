# Org authority read and confidential exchange pool contention

The 28 October production window contains four Prisma `P2028` failures on
revision `uoa-auth-00349-fxk`, image source
`f744cc177c974ad21e81647e9da20163a6dd12e3`. The `/org/me` transaction expired
after its 5,000 ms budget; confidential exchanges failed during transaction
acquisition or while acquiring the canonical user lock. The source suggests
a cycle between the app transaction's shared user lock and the two occupied
admin-pool connections. The production-base PostgreSQL run below reproduces
that cycle with a passing control. The candidate source repair keeps the
complete authority projection on one admin transaction. The reviewed source
now passes the focused 47-case Maxis gate with exit 0 and no unhandled errors.
Upstream CI, release and live recovery remain coordinator-owned gates.

`API/tests/integration/org-me-pool-contention.test.ts` exercises the actual
HTTP routes and PostgreSQL locks with the documented pool sizes: three app
connections and two admin connections. It uses the real non-BYPASSRLS
`uoa_app` and BYPASSRLS `uoa_admin` roles, signed source assertions, an original
independent session-assurance record, current credential epoch, an exact
ACTIVE org/team pair and a registered confidential delegation. External key
transport is synthetic; no provider or production endpoint is called.

The first case verifies that the read and exchange work without contention,
that a still-valid GET assertion is reusable, and that a token-exchange
assertion remains one-use. The second pauses the read at its platform-role
lookup after the shared epoch lock is held. It starts two valid exchanges,
then checks `pg_locks` for real exclusive waiters occupying every remaining
admin connection on that exact user key before resuming the read. The deployed
app-pool reader owns no admin slot, so both slots must have verified waiters.
A reader owning one admin transaction instead leaves one slot for a waiter;
the second exchange remains queued until a slot is released. The test expects
all operations to complete successfully;
the deployed source is expected to fail that assertion with `P2028` if the
suspected cycle is reproduced. A failed control is a fixture or independent
failure and does not prove the cycle.

Provisioning occurs in `beforeAll`, using the existing isolated-schema helper.
The initial test connection needs permission to apply migrations, create the
`citext` extension, create/configure the two test roles and grant schema-local
privileges. Use only a dedicated disposable PostgreSQL instance/database.
The suite refuses to run without `DATABASE_URL` and restores its environment,
releases scheduling barriers, closes clients and drops its isolated schema.
It does not change global PostgreSQL role attributes beyond the helper's
existing test LOGIN/password setup.

Run on the coordinator-assigned Maxis worktree with the disposable database
already supplied through the process environment:

```powershell
$env:TZ = 'UTC'
pnpm --filter @uoa/api exec vitest run tests/integration/org-me-pool-contention.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

The original regression commits change no production source. No native
application inputs change, so native builds are outside this work's scope.

## Measured production-base result

The baseline is deployed source `f744cc177c974ad21e81647e9da20163a6dd12e3`
plus regression-only commit `a3893f65545a6640ff20b7c56d1bed8c7adc9a4a`.
Maxis ran Node `v24.19.0` in `D:\Worktrees\uoa\ars-1028`, using the dedicated
PostgreSQL 16 fixture `uoa_ars_20261028` on loopback port 55432. Production source,
schema and dependency inputs matched the deployed base. The finalized
`source-proof.json` SHA-256 is
`5a7e4dee7cdae7b5ce349ff3f453149b40fa684a8511ac993696aae6c81961e2`.

Lint, Prisma generation, slug build and protocol build passed. The initial
`repro-20261028T190723055Z` run exited 1 before either case ran: two skipped
cases, `success=false` and failed suites. Its helper incorrectly labelled zero
failed cases as `unexpected_green`; that label is rejected. The original
files remain immutable. The JSON-only reporter omitted the setup error, so
this run proves neither a successful control nor a pool cycle.

The warmed `warm-20261028T200222264Z` run used default and JSON reporters,
the same source, database, production pool caps and default interactive
transaction limits. It completed **one passing control and one expected failing
contention case, with no skipped cases**. The control proved real runtime RLS
roles, two successful reads of the same GET assertion, one successful
confidential exchange, and rejection of that exchange assertion's replay.

Before resuming the contended read, the measured PostgreSQL topology was:

| Phase | Shared readers | Admin readers | Waiting exclusive writers |
| --- | ---: | ---: | ---: |
| Paused authority read | 1 | 0 | 0 |
| Both admin slots occupied | 1 | 0 | 2 |

After release, `/org/me` returned 500 where 200 was required. Sanitized errors
were `P2028` on `/org/me` and both `/auth/token` requests. This proves the
bounded pool/lock cycle for the tested condition and matches the production
error class; it does not attribute every historical authority failure to it.

The following files live outside the disposable worktree in
`D:\BuildArtifacts\uoa\agent-reliability-20261028`:

| File | SHA-256 |
| --- | --- |
| `warm-20261028T200222264Z-manifest.json` | `36f52ee2a80ce8d0d75e3e41d8b6338a53a24461e4a961c2fb89e27ae2bde542` |
| `warm-20261028T200222264Z-vitest.json` | `0df99bf99fbe33d49c309435dafe8abe45d73e7bfdcd45408a94ef2bbcc4a395` |
| `warm-20261028T200222264Z-regression.log` | `afbcb292bb9274e7d41c21925450742210f41cff0006c334008e17dd30fdb418` |
| `repro-20261028T190723055Z-manifest.json` | `2e39a7bde2ef3e3b63b5b6974953d2ece54642c821071f2d2f59a5c3ea3bb409` |
| `repro-20261028T190723055Z-vitest.json` | `723d3cb1b1d06096e2fd5b80846788ed15a61f22890acc376683216cac3f65f4` |
| `repro-20261028T190723055Z-regression.log` | `5d4b73965d79dcdea35eebd7b36cb2e5a47ddbb5bffe20edcb39701388b9f678` |
| `verify-maxis-warm-a3893f65.ps1` | `a23525978d4e1cfdc60f2d167aac60930992534194763aa56d63645bc6dca348` |

A read-only refresh after reproduction confirmed `origin/main` still equals
`f744cc177c974ad21e81647e9da20163a6dd12e3`, with no newer change to this path.
Cloud Run's latest ready and created revision remained `uoa-auth-00349-fxk`,
serving image digest
`81cdbad0595d291124e724fdb342c5f292c04d2ad24d22619732971f5e5258eb`.

## Candidate boundary and verification

`/org/me` uses one `runWithRequestAdminTransaction` for its complete bootstrap
projection. The existing effect-authority check pins the shared product-policy
and canonical user epoch fences and repeats current domain/identity/member
checks. A supplied assurance proof is revalidated on that transaction after
preflight. Every platform role, selected org, product-policy, team-directory,
invitation and self read receives the same transaction client. This removes
the second-pool dependency while keeping the locks that block revocation
through the snapshot and commit.

The narrow RLS exception and its security proof are in
[RLS §10.15](../Requirements/row-level-security.md). Directory queries now
explicitly require the acting user's ACTIVE org/team memberships and ACTIVE
org/team lifecycle even on the admin client. Cross-domain reach still requires
the existing server-owned product policy. Invitation address/reach, recency
domain and self-subject filters remain exact. No SQL grant, policy, pool cap,
transaction timeout, cache, credential store, POST exchange or release
configuration changes. The endpoint request/response schema is unchanged.

The candidate adds six deterministic revocation cases after successful
credential preflight: epoch, identity lifecycle, org membership, team
membership, session assurance and domain secret. A real PostgreSQL directory
case excludes orphaned memberships and disabled entities, then verifies that
foreign-domain reach changes only with the server-owned product mapping.
Unit guards require every read to use the handed transaction and reject
authority/assurance failures before returning a projection. The existing
same-pool checkout guard remains active in real PostgreSQL tests.

After source review, run focused ESLint and API typecheck, then the following
single-worker suite on the assigned Maxis fixture:

```powershell
pnpm --filter @uoa/api typecheck
pnpm --filter @uoa/api exec vitest run tests/integration/org-me-pool-contention.test.ts tests/integration/org-me-cross-org-invites-rls.test.ts tests/integration/org-user-endpoints-me.test.ts tests/unit/org-me.route.test.ts tests/unit/team-directory.service.test.ts src/db/__tests__/pool-checkout-guard.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism --hookTimeout=900000 --testTimeout=30000
```

The first candidate run, `candidate-20261028T202351503Z` at source
`2ec76e92a7d5776657f063ece74b89f71d65da31`, passed scoped ESLint and API
typecheck. Its six-file suite completed 45 of 47 cases successfully, with no
skips. The production-pool control, repaired overlap, all six after-preflight
denials, live platform authority and transaction/checkout guards passed.
The overall gate remained red because two fixture assumptions were wrong:

- The new directory fixture assigned memberships after creating an already
  disabled organisation; the existing SQL lifecycle-reference guard correctly
  rejected that setup with SQLSTATE `23514`. The fixture now creates valid
  ACTIVE references first, then disables the container before the read.
- The existing cross-org invitation case asserted that its caller had no
  Bravo team, but `addOrganisationMember` automatically joined Bravo's default
  team. A positive read now proves that ACTIVE same-domain placement is visible
  despite the selected Alpha context. The last-team guard forbids removing its
  only Bravo team, so the fixture removes the Bravo organisation placement
  through the actual local lifecycle/revocation route and verifies the org and
  teams are tombstoned before testing invitation-only visibility. It retains
  the original invitation and final directory assertions.

These corrections change no production code or security expectation. Their
subsequent runs and final acceptance are recorded below. The failed candidate
evidence remains immutable:

| File | SHA-256 |
| --- | --- |
| `candidate-20261028T202351503Z-manifest.json` | `aa3a049612c01f16405cb30c1d828421a8b968476c6565e896106c8a6c019d85` |
| `candidate-20261028T202351503Z-vitest.json` | `9d01e70d227f349b662a66873a2487672795c98f638b06cb9404206689882988` |
| `candidate-20261028T202351503Z-regression.log` | `a471324766db993e595d2f1eec9561e581af4f32a3cf7068b95ea5b0801c460a` |

## Fixture provisioning and worker RPC recovery

The corrected-source retry `candidate-20261028T203649477Z` at `3927e38c`
passed 32 unit cases but skipped all 15 database-backed cases after three
`beforeAll` hooks exceeded 180,000 ms. Its report is a setup failure, not a
behavioral pass. A bounded read-only PostgreSQL snapshot at `20:56:09.893Z`
found one current migration backend waiting on `IO/DataFileImmediateSync`,
query/transaction age 121 ms, no blocking PIDs and all locks granted. The
backend's client port matched the owned migration engine. No earlier remnant
or lock blocker was observed, and no fixture was cancelled or deleted to
recover it.

The coordinator approved a bounded runner-only 900,000 ms fixture-hook budget
while retaining 30,000 ms behavioral cases, default 5,000 ms interactive
transactions and the production three/two pool regression. No source timeout
or database setting changed.

That run, `candidate-20261028T212809000Z`, completed all **47 cases successfully,
zero skipped cases and zero failed suites**. Control, repaired overlap, all
six denials and both the ACTIVE-Bravo and invitation-only directory states
passed. It still exited 1 because Vitest caught two unhandled errors:
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"`. This is not accepted
as a green gate despite the passing assertions.

Inspection of pinned Vitest 3.2.6 confirms its bundled birpc default timeout is
60,000 ms (`dist/chunks/index.B521nVV-.js:3,21`). The worker wrapper throws that
exact error (`rpc.-pEldfrD.js:49`), and fork transport options do not replace
the deadline. `tests/helpers/test-db.ts` used `execFileSync` for setup,
migration and cleanup, blocking the worker event loop and its RPC
acknowledgments during slow CLI work. The fixture helper now awaits an async
spawn for the same executable, argv, environment and SQL input. Stdout remains
ignored; the default 1 MiB stderr bound and overflow termination, all six
startup attempts and their backoff, failure propagation and awaited schema
cleanup remain in place. The runner's RPC deadline is unchanged, and no
unhandled error is suppressed. The clean-exit run below validates that correction.

These setup/reporting runs remain immutable under the same artifact directory:

| File | SHA-256 |
| --- | --- |
| `candidate-20261028T203649477Z-manifest.json` | `d5a98754d2f8e82309f3362731cd08838cdb37e8d90b990aee107563f203c05e` |
| `candidate-20261028T203649477Z-vitest.json` | `b9a78d0a0cda9382ea631cea62c6894d8d18213f7887a43e4655928a38ba5bf2` |
| `candidate-20261028T203649477Z-regression.log` | `18399c74d9c25214bc340be28abcdd6672de03e8bc9757d661e47c1143abc740` |
| `candidate-20261028T203649477Z-pg-waits-20261028T205609970Z.json` | `f66443ac0dddc6b0cadfb170bf2231c82f967182ba8454f1ecfe1fd30c61e8ba` |
| `candidate-20261028T212809000Z-manifest.json` | `0b02d14785635daa81545bf31d7586cb999cea216557ec75bd77aa7dcdab19ef` |
| `candidate-20261028T212809000Z-vitest.json` | `9c861bfdbcfb9e2a838b0ae463c0a1857047bed956e9a0a9b5b870121eb8dca5` |
| `candidate-20261028T212809000Z-regression.log` | `23da59b273a945e4c586e49b584cfe33f2039ac7412c11e8a068abf02b9d8055` |

## Central fixture outage and recovery

The first async-helper run, `candidate-20261028T214642336Z`, could not reach
the central fixture: 32 unit cases passed and 15 database cases were skipped
after Prisma `P1001` setup failures. It had no unhandled RPC errors, but remains
a failed setup run. A read-only check found no listener at the exact fixture
endpoint, no original postmaster PID, and readiness exit 2. The existing log
placed shutdown completion at `21:36:18.674Z`, before this run.

The fixture owner identified Windows commit-limit exhaustion in that log:
backend exception `0xC000012D`, followed by `CreateFileMapping` error `1455`
during attempted server reinitialization. The owner restored the same persisted
cluster without reinitialization, deletion, configuration, role, port or pool
changes. Independent SSH and SQL at `22:17:30Z`, after the launcher exited,
confirmed accepting connections, cluster ID `7701694579055700452`, all four
existing fixture databases and unchanged configuration hashes. Commit headroom
was 31.68 GiB. The owner's health proof SHA-256 is
`0f0dae4779d0ad120e6dcb152be1ee075e8f2a6fb70c074b93b3e5de07d394f5`.

| Failed setup file | SHA-256 |
| --- | --- |
| `candidate-20261028T214642336Z-manifest.json` | `84e23d1c66e31164ba664700bd25f6e4a7eef6a47d8eab0305344fd72ace1891` |
| `candidate-20261028T214642336Z-vitest.json` | `bd45f47814d08f3df51dc213029b9124e3f1761c7d0c54dbee6b775fa537a8a1` |
| `candidate-20261028T214642336Z-regression.log` | `aeb696fed480dafd97a73971c3d2d5849160f105b5e72fe23fcda7f93626ea33` |

## Final focused acceptance

`candidate-20261028T221846349Z` ran the same six-file selection on Maxis at
source **`2814ee39b139ca58ba688ad5959872007fcbc662`** against the restored
`uoa_ars_20261028` fixture. It finished with **47 passed, zero failed, zero
skipped, zero failed suites, zero unhandled errors, Vitest exit 0 and launcher
exit 0**. The passing cases include:

- Real-role and assertion-replay control, plus the repaired read/exchange overlap.
- All six post-preflight denials: epoch, identity, org membership, team
  membership, assurance and domain secret.
- Live directory membership/lifecycle/product-policy exclusions, a positive
  selected-Alpha read exposing the caller's legitimate ACTIVE Bravo placement,
  and the invitation-only read after supported org placement removal.
- Live platform authority/revocation, tenant invitation reach, and transaction
  threading/checkout guards.

Focused ESLint on the newly changed `API/tests/helpers/test-db.ts` passed with
zero warnings. The earlier passing source/route/test lint results remain
applicable. API typecheck passed at `2ec76e92`; the runner verified unchanged
compiled inputs before reusing that result, whose log SHA-256 is
`f432ad24f20f6388562567bc5382356ddf0bb0e86dd66d5bcb7efdc974ee7901`.

The final runner records fixture hooks at 900,000 ms, behavioral cases at
30,000 ms, unchanged worker RPC at 60,000 ms, unchanged interactive transactions
at 5,000 ms, and the three/two app/admin pool regression caps. Fixtures use
awaited async CLI execution with the unchanged 1 MiB stderr bound. Neither
unhandled errors nor database cases are suppressed.

| Passing file | SHA-256 |
| --- | --- |
| `candidate-20261028T221846349Z-manifest.json` | `7f0a0df3648d1e0b8b9765a30f81d52df783966cc228c3595abc7c0000f66542` |
| `candidate-20261028T221846349Z-vitest.json` | `e0b273d5a3d542a876a0ed7c3a998f226e75b7ff9870f1d5bb56910cabbd10bb` |
| `candidate-20261028T221846349Z-regression.log` | `99a661b53209f901ba67d6bd74a4fb534a027d87c329fe98b676de9e7d354dbc` |
| `candidate-20261028T221846349Z-lint.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The worker created no pull request, deployed no revision and made no live
state change. This focused result establishes the tested source repair and
its denial boundaries; it is not production recovery or proof about every
historical authority failure.

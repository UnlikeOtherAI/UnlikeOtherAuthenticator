# Org authority read and confidential exchange pool contention

The 28 October production window contains four Prisma `P2028` failures on
revision `uoa-auth-00349-fxk`, image source
`f744cc177c974ad21e81647e9da20163a6dd12e3`. The `/org/me` transaction expired
after its 5,000 ms budget; confidential exchanges failed during transaction
acquisition or while acquiring the canonical user lock. The source suggests
a cycle between the app transaction's shared user lock and the two occupied
admin-pool connections. The production-base PostgreSQL run below reproduces
that cycle with a passing control. The candidate source repair keeps the
complete authority projection on one admin transaction; candidate verification
is pending review and the next coordinator-assigned serial slot.

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
single-worker suite on the assigned Maxis fixture. Candidate checks have not
yet run:

```powershell
pnpm --filter @uoa/api typecheck
pnpm --filter @uoa/api exec vitest run tests/integration/org-me-pool-contention.test.ts tests/integration/org-me-cross-org-invites-rls.test.ts tests/integration/org-user-endpoints-me.test.ts tests/unit/org-me.route.test.ts tests/unit/team-directory.service.test.ts src/db/__tests__/pool-checkout-guard.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

# Org authority read and confidential exchange pool contention

The 28 October production window contains four Prisma `P2028` failures on
revision `uoa-auth-00349-fxk`, image source
`f744cc177c974ad21e81647e9da20163a6dd12e3`. The `/org/me` transaction expired
after its 5,000 ms budget; confidential exchanges failed during transaction
acquisition or while acquiring the canonical user lock. The source suggests
a cycle between the app transaction's shared user lock and the two occupied
admin-pool connections. A source repair remains pending measured reproduction.

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

No production source, RLS policy, timeout, assertion replay rule, identity
store, permission or release configuration changes with this regression.
No native application inputs change, so native builds are outside its scope.
The first central run and any narrow repair require separate recorded results.

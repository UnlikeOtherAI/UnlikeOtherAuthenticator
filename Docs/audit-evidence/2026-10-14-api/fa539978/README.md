# API validation checkpoint — fa539978

Maxis runs all Node/compiler/API commands, one worker, Node heap capped at3072MiB.
Owned PostgreSQL16 runs in Fedora container `uoa-api-audit-pg-20261014`, label
`uoa.audit.owner=sol-audit-api-20261014`,512MiB/1CPU, loopback55460 over SSH.
Existing liveness55440 and pricing55445 are untouched. No production access.

- Shared slug, billing protocol and auth UI string builds: pass.
- Prisma schema validation/client generation and API TypeScript build: pass.
- All3 compiled workspace package imports: pass.
- Clean database: all206 migrations apply, including the6 new API migrations.
- First default-harness runtime gate:60pass/1fail across4files.
- Signed org/team capability routes:17pass, including custom grant and owner cases.
- Admin debug/logout routes:3pass, including exact bearer401, sibling200 and no
  global epoch bump; PKCE, independent family and negative authority checks.
- Bulkhead unit middleware:37pass. Real socket route fixture is a separate gate
  and has not run at this checkpoint.
- Directory ordering:3pass (rollback, observed advisory waiter/commit order,
  multi-org/terminal cursor); RLS fixture fails at setup because an ACTIVE org
  needs a canonical owner. It did not reach its RLS assertions. Fix the fixture,
  retain the owner constraint, and rerun. No completed U1/U3 acceptance claimed.

The runner exited1 and no assigned API compiler/test children remain. The heavy
slot is explicitly released while correcting source/fixtures. The owned DB and
SSH tunnel remain available for the next gate; no reset or stuck-record removal.
Logs redact PostgreSQL URLs and contain only synthetic test identities.

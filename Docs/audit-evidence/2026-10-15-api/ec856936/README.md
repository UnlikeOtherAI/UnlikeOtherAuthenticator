# PostgreSQL runtime gate 3 — ec856936

Maxis serial runner, one worker, heap 3072 MiB; owned Fedora PostgreSQL16 via
loopback tunnel. Audit schemas retained. Protected databases untouched.

Gate stopped on its first failing file: entity-lifecycle.test.ts, 14 passed,
1 failed, four cases not run. Other five selected files did not run.
The 25-member/250-audit-row deletion case exhausted the begin-deletion
15-second transaction during repeated eligibility/billing preview reads.
Sanitized full stdout is retained. Exit 1. This is not runtime acceptance.

No record was canceled, removed or edited to clear the failure. The schema is
retained in the owned audit database. Compiler/test process completed; slot
released for source correction. The legacy-upgrade test has not run yet.

## Runtime gate 4

Same production/test source as ec856936 (d99efd5e adds evidence only).
Four suites pass: native refresh9, registered native sign-in11, native account5,
shared epoch-reader/exclusive-writer race1. Total26pass.
Upgrade fixture setup fails before database creation: spawnSync git ENOBUFS;
the pinned Prisma archive is 1,648,640 bytes, above Node's default capture buffer.
This is a test fixture correction, not a migration result. Runner exit1.
All four audit schemas retained. No compiler/test child remains; slot released.
Original failed lifecycle schema retained:
`test_1792020456339_917eba68851844088fd9bd99a2a90164`.

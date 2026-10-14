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

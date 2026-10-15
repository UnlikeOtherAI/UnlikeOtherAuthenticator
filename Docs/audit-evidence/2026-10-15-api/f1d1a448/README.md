# Real mixed-version website rollout acceptance — f1d1a448

Maxis, serial, one worker, Node heap3072MiB; owned PostgreSQL16. All17tests pass:
5actual pre-audit/current reader cases plus12rollout/reader-floor unit cases.
Current public JWT client_id is stable and contains no pairing bearer. Legacy
storage remains unchanged across mixed-reader rotation/replay, debug issue/redeem,
and revoke. Stable mode returns503 for unmigrated rows without conversion; actual
old reader still reads those rows. Reviewed bridge reads stable rows; actual old
reader refuses them without consuming the row. Exact config/domain mismatches and
revoked pairing refuse without consuming legacy capabilities. Exit0,62.83seconds.

Pre-audit source pinned0bd21cb71d9b429a0b521b9443a2354a68e5130d, imported directly
from a temporary archive inside this worktree. No old build/server started; archive
removed afterward, audit DB schema retained. No production secret/deployment change.

Provider-floor source/executable shell evidence remains in b95098a6 (10cases),
and bridge/stable/migration runbook remains required before real cutover.
The new TCP test files at3dd69bf7 were unselected and did not change these inputs.

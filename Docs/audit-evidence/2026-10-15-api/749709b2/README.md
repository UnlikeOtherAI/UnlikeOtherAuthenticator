# Admission/factor gate — 749709b2

Owned PostgreSQL16, Maxis serial runner, one worker, heap3072MiB.
Passes9cases: email first-placement GET/POST race+rollback3; email verification5;
social auto-selected code/access/refresh/rotation binding1.
Then first-placement-advisory-race fails with real PostgreSQL40P01:
lockRequiredTeamPlacementUser waits on the placement advisory lock while the other
transaction holds placement and requests the exclusive canonical user lock.
This is a real shared-to-exclusive user-lock upgrade cycle, not a fixture failure.
Remaining5selected files did not run. Overall9pass1fail, exit1.
All audit schemas retained; no item/lease/record reset. No aggregate acceptance.
Runner completed; validation slot released for source correction.

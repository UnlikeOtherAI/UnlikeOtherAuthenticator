# Retained original deletion recovery — 1391d4d0

Real owned PostgreSQL16, Maxis serial runner, one worker, heap3072MiB.
Original schema: test_1792021505371_8ccd14845ee54fb7992a1ed98ebde59b.
The original job began with8/26 completed users and its retained natural lease.
Normal executeEntityDeletion calls returned READY five times, then COMPLETE.
One test passes,93.85seconds, exit0. All26 committed subjects complete;250audit
rows preserved and scrubbed; directory terminal cursor/event unchanged through
remaining erasure. No fixture seeding/reset, manual lease/progress/blocker edit,
cancel or record removal. The recovered schema remains retained.

This proves recovery of that actual failed job. Full lifecycle regression,
refusal cases, full113-writer runtime and remaining race gates stay open.

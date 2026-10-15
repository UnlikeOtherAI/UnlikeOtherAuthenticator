# Authority writer gate — 3ab64f90

Full API typecheck passes. Real PostgreSQL access-assignment/lifecycle race now
passes after the policy-first correction. Five admission writer cases pass:
team-avatar create/replace/delete over HTTP; fresh/re-invited members and prior
owner-only profile invalidation; complete invitation/profile/membership/outbox
rollback; concurrent final link use; exact org/team/user quotas with rollback.

The expiry test fails because its barrier targets teams, not an existing
membership row. For a fresh user, membership row locks find no rows; the actual
wait is the FK insert after the atomic link claim accepted before expiry. That
is not evidence of a stale lock-time claim. Correct the fixture to block an
existing TeamMember row before the explicit expiry recheck. No production
expiry/clock-tolerance policy changes are justified by this failure.

Six passes,one failure, exit1. Other selected files did not run. Owned schema
test_1792027753519_5c5a347771ab43d0bbbde6385be63228 retained without reset. Maxis
one-worker heap3072MiB runner ended; slot released before fixture correction.

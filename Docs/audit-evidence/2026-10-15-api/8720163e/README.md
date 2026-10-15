# Unit gate after lock-order correction — 8720163e

API build passes. Unit-only run stops at474passes/1failure: profile HTTP fixture
does not implement organisation.findMany required by the complete owner-reference
scope resolver. The actual three-org PostgreSQL gate already passes; this is a
stale unit fixture, not grounds to weaken the resolver. Fixed fixture, runtime
and full suite reruns still pending. Exit1, no aggregate acceptance. Slot released
with runner ended before fixture correction. New integration tests committed
during the run were not selected inputs; production source remained unchanged.

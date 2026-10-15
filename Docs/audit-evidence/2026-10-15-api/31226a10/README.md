# Access-assignment policy lock inversion — 31226a10

Full API typecheck passes. Real PostgreSQL race fails with40P01 between
ensureUserAssignedToConfiguredAccessTarget and the supported canonical lifecycle
writer. Assignment holds shared user then asks for shared policy; lifecycle
holds exclusive policy then asks for exclusive user. Real PG waiter observation
precedes barrier release; no mocked query supplies the result. Assignment commits,
lifecycle transaction rolls back. One failure, exit1. Owned schema is retained;
no records, items or leases are deleted/reset. Maxis serial runner ended and
slot released before source correction. No113writer acceptance or N03cutover.

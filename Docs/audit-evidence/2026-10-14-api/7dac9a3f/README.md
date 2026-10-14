# API runtime gate2 — 7dac9a3f

Maxis serial API build passes with Node heap3072MiB. Runtime uses the existing
owned512MiB Fedora PostgreSQL16 instance on55460; protected55440/55445 untouched.

23/23 tests pass across3 files:
-11 profile/directory HTTP/PostgreSQL tests: actual uoa_app login (not BYPASSRLS),
 sibling-org RLS, denied cross-tenant event rolls canonical write back, private
 machine outbox, signed config/domain/user JWT, canonical current self read/PATCH
 with exact event, stale/absent/conflicting credentials, observed real lock waits
 and expiry refusal, nullable ACTIVE display, exact retained history and erased
404, actual uploaded avatar bytes, supported operator/owner provisioning, exact
 permissions, former-owner refusal, directory expiry/revocation serialization,
 and PostgreSQL permission failure retained as generic500.
-4 directory seam tests: app-role tenant restriction, rollback, observed waiter
 commit order, sorted multi-org locks and final terminal event.
-8 real-socket bulkhead route tests, including disconnected queued/running work
 and early preHandler replies while service phases remain counted.

No compiler/test children remain after runner exit0. Slot released for source
correction. The owned DB/tunnel remain available. This is strong focused evidence,
not full113-writer/upgrade/API aggregate acceptance; no N03 cutover is certified.

# Real pre-audit/current reader gate — 4b42fe97

Maxis serial runner against owned PostgreSQL16, one worker, heap3072MiB.
The actual pre-audit reader is imported from pinned0bd21cb71d9b429a0b521b9443a2354a68e5130d;
no old server/build is started. Current issuance/refresh/debug/revoke use API routes.

Four cases pass: stable JWT ID plus mixed-version rotation/replay on legacy rows;
website debug issuance/redemption and independent sessions with unchanged source
storage on revoke; stable legacy refusal503 while old reader still works;
reviewed bridge reads stable rows while actual pre-bridge reader refuses them.
Fifth case passes exact config/domain mismatch assertions, then its secret-revocation
fixture uses clientDomainId instead of the schema's domainId. It stops there.
Overall4pass1fail, exit1; no full U01 runtime acceptance yet. Schema retained.
Slot released after runner completion for fixture correction.

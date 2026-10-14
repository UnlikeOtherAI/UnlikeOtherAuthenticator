# Complete API unit/source gate — b95098a6

Maxis, serial, one worker, Node heap3072MiB. No database configured; the normal
harness's local JWKS listener is used. No production/provider operation.

- Actual deployment preflight shell block with synthetic provider inventory:10/10.
- Deployment YAML parses successfully.
- API TypeScript build passes.
- Default API unit/source suite:2586pass,75fail,3skipped (2664tests),
 26failed/369passed files (395total),251.93seconds. This is not acceptance.
- Existing U28 config/capability tests pass:14 config,15 role grants,15 org
 capabilities and11 team capabilities, in addition to the17 real HTTP cases
 recorded atfa539978. The domain-authored contract has not been removed.

Failure families to correct: missing explicit directory scope/query delegates
in mocked stores; old bearer-valued JWT client-ID fixtures; missing online Admin
revocation marker delegates; native failure-limiter export classification;
new planned-org ID expectations; one hardcoded beforeAll timeout rejected by
the existing provisioning-hook guard. Six Auth HTML/CSP assertions need the
actual Auth dist build, which has not yet been produced in this worktree.
Two chooser500 fixtures also require individual diagnosis. Production guards
will not be weakened to satisfy outdated fixtures.

Full sanitized stdout is retained. Token-like long test values and PostgreSQL
URLs are redacted. Runner exited1 and no assigned compiler/test children remain.
Slot released for fixture/source correction; owned audit DB/tunnel preserved.

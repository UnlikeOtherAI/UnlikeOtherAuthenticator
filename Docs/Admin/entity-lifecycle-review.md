# Entity lifecycle review and rollout

The 8 November 2026 user clarification supersedes the earlier last-team cascade:
explicit TEAM deletion preserves the organisation. Before deploying this change,
check the count of unfinished legacy TEAM jobs whose stored preview has
`effectiveScope != TEAM`. The product delivery and executor refuse those old
expanded scopes with `DELETION_TEAM_SCOPE_RECONCILIATION_REQUIRED`. Do not cancel,
delete or edit a job to hide it; inspect its committed product acknowledgements
and completed stages before a separately reviewed reconciliation. Completed
historical erasure is not reversible and is never represented as restored.

## Decisions

UOA remains the authority for human identities, organisations, teams, membership, and invitations. Products retain stable UOA references and their own content. Entity access state is separate from membership: disabling an organisation denies access through its teams without overwriting their independent state. Reactivating a parent does not reactivate an independently disabled child.

Platform administrators can disable users, organisations, or teams using a scoped, revisioned reason template. The customer message is snapshotted at the time of the action. Internal notes remain administrator-only. Account-status mailbox proof, with enrolled TOTP where applicable, reveals authorized reasons without issuing a login session. Signed website configuration and registered native-client context remain separate trust boundaries.

Two account deletion modes are exposed:

| Mode | Operational identity | Retained organisation history |
| --- | --- | --- |
| Retain a Deleted user reference | Credentials, name, email, provider links, avatars, settings, and mutable identity copies are removed. The original ID becomes terminal. | Authorized products resolve `{id, deleted: true, name: "Deleted user"}`. The boolean derives from lifecycle state. |
| Erase identity references | Mutable subject references are detached or neutralized; the identity row is removed when no protected reference requires a restricted stub. | Interactions may remain without the original author ID. Explicitly inventoried protected evidence is an exception. |

Neither mode allows the old identity to authenticate or regain membership. Registering the same email creates a fresh identity. Ownership of a surviving organisation must be transferred before deleting its owner.

Team deletion removes data in the selected team and includes accounts only when they have no dependency elsewhere. Organisation deletion covers its nested teams. Shared accounts and accounts with personal or protected dependencies survive. Deleting the last team preserves the now-empty organisation and its active memberships/owner/admin authority for Create team recovery. The executor never expands TEAM consent into organisation deletion; captured financial evidence and holds remain authoritative.

Invoices, signed agreements, and other protected historical evidence remain under their existing restricted access and immutability rules. Operational grants and unsigned capabilities are not automatically treated as protected evidence. Live collection capabilities must be closed or transferred before confirmation. Completion states explicitly distinguish operational deletion from retained evidence.

## Problems addressed

- Direct team/organisation deletion could bypass a complete dependency preview. Those routes now refuse with `ENTITY_DELETION_WORKFLOW_REQUIRED` and direct callers to the administrator workflow.
- Membership state alone could not express a suspended account or ancestor. Central token, issuance, billing, and feature checks now require active lifecycle state.
- Deleting a foreign-key row could either destroy organisational history or leave personal data in secondary records. Terminal identities and explicit operational sweeps separate those outcomes.
- A single long cleanup transaction would be vulnerable to request timeouts and hold authentication locks too long. Deletion jobs freeze their scope first, then advance through leased, durable cleanup stages.
- An erased entity's detail page cannot be the only place to track cleanup. `/admin/deletion-jobs/:jobId` remains addressable independently of the original record.

## Operator flow

1. Maintain reusable customer messages at **Access reason templates**. Templates are scoped to User, Organisation, or Team and retain revision snapshots on disabled entities.
2. Open **Security** on a user or **Access** on an organisation/team to disable or reactivate access.
3. Choose identity handling and request a deletion preview. Review cascade scope, accounts removed or kept, product acknowledgements, financial blockers, and restricted retained evidence.
4. Type the preview's exact confirmation. A digest binds confirmation to the current scope and dependencies; changed data requires a fresh preview. Retry an uncertain submission with the same request key.
5. Follow the permanent deletion-progress page. Missing product acknowledgements block completion. After products acknowledge, **Finish or retry deletion** advances local cleanup; a READY job can require additional bounded stages.
6. Review the completion record and its retained-evidence inventory. Do not describe that outcome as a complete physical purge when restricted evidence remains.

## Connected-product rollout

This repository implements the UOA side of deletion. Each consuming product must deploy an adapter before deletion can complete across that product:

1. Authenticate using its exact registered ClientDomain bearer and pull `/domain/deletion-jobs`.
2. Apply the committed `effectiveScope`, `effectiveTargetId`, `teamIds`, identity mode, and `accountsToDelete` to its product-owned content. Never infer a broader user or organisation scope.
3. Commit cleanup before acknowledging the exact job revision. An acknowledgement is evidence of completed work, not receipt of a request. Retries must be idempotent.
4. Return bounded summaries of restricted retained evidence when applicable. Do not include unrelated personal data in summaries.
5. Use the historical-identity endpoint only for authorized retained subjects. Do not reconstruct a parallel profile store.

Unknown inventory or an unacknowledged product is a visible blocker, not success. UOA cannot attest to content a product never associated with its identity or organisation references. Inventory and adapter deployment must therefore be verified for each consuming product. Existing offline JWTs also need online revocation/introspection or bounded expiry; changing UOA state cannot rewrite a token already delivered to a product.

## Verification record

The 2026-11-08 organisation billing change supersedes the former last-team
cascade: explicit TEAM deletion preserves the organisation and its active
people for Create team recovery. It adds a database deployment fence as well as
delivery/executor checks. Before applying the migration, inspect unfinished TEAM
jobs; the migration repeats the check under a write-conflicting table lock.
An incompatible preview or missing `preserve-org-v2` policy blocks installation.
No pending job is rewritten or erased. Fresh previews and executor leases carry
that policy marker so an old Cloud Run revision cannot create or execute the
former destructive semantics during overlap. Completed historical jobs stay
intact. Authentication does not depend on the deletion executor.

The implementation is reviewed in an isolated integration branch with a separate Sol worker branch. Required delivery gates include workspace builds, lint/type checks, API unit and real PostgreSQL integration tests, and durable desktop/mobile browser flows. The final pull request records the exact completed checks and any environment limits. No production identity or organisation deletion is performed as part of development verification.

Final local verification on 2026-10-03 covered the Linux Node 22 workspace build and DB-less API suite; Windows API lint/typecheck/build; 118 Admin and 143 Auth unit tests; 30 Admin browser cases plus four website/native access-status browser cases across desktop and mobile. PostgreSQL 16 verification included the full integration suite and focused reruns of every corrected failure, including production RLS roles, transaction authority, 25-account resumable cleanup, protected sibling teams, and current session-broker denial. Dependency audit passed the high/critical gate; existing lower-severity findings remain. The pull request CI repeats the API build, DB-less suite and PostgreSQL suite against the integrated revision.

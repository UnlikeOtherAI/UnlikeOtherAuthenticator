export const llmCreationRecoveryMarkdown = `
## Organisation and team creation recovery

Check GET /api for org_creation_recovery.capability=org_creation_recovery_v1 and
version=1 before relying on retries. On POST /org/organisations and POST
/org/organisations/:orgId/teams, send a random Idempotency-Key (16–200 ASCII
letters, digits, dot, underscore, colon or hyphen). Persist it with the original
request before sending. Do not put personal data or credentials in the key.

UOA commits the resource, default team, requested memberships, audit and minimal
receipt in one transaction. A concurrent or later matching POST returns the
same resource IDs with currently authorized fields. Different effective inputs
under the same key return 409 CREATION_KEY_CONFLICT. Header absence preserves
ordinary creation and provides no replay guarantee.

After a lost response, GET /org/organisations/creation-status or
/org/organisations/:orgId/teams/creation-status with the same header and normal
domain/config authentication. Successful response is
{status:"committed",organisationId,teamId}; teamId is the original created or
default team. Only 404 CREATION_OPERATION_NOT_FOUND means no committed receipt
was found and permits another POST with the original key and body. Transient
failures, including 429/503, retain the operation and retry with bounded backoff.
Status reads do not spend the creation rate-limit budget.

Keys are scoped to the original registered domain, authenticated user or explicit
backend mode, operation and parent. They are not credentials. Every replay and
lookup rechecks current authentication and resource authority. Never substitute
another user or silently change the parent. Receipts contain hashes and stable
IDs, not names or tokens; they remain immutable after resource deletion.
CREATION_RESULT_UNAVAILABLE, revoked authority and deleted resources never
permit recreation with that key. This protocol cannot reconstruct a historical
unkeyed request whose response was lost. Do not guess its result from names.
`;

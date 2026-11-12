# Organisation and team creation recovery

Products use their existing organisation/team Create form. Recovery is an API
contract, not a new end-user screen or consent step. The caller persists a random
operation key and its original request before dispatch, then keeps that operation
until a confirmed result or a definitive refusal. A lost response is retryable.

`GET /api` advertises `org_creation_recovery.capability=org_creation_recovery_v1`
and `version=1`. Consumers must verify this capability before relying on the
contract. Older servers ignore unknown headers and cannot provide this guarantee.

Before dispatch, call authenticated `GET /org/creation-contract` and persist its
`registrationId` alongside the operation key. Every keyed POST and status GET
must send that ID in `X-UOA-Creation-Registration`. Missing or different IDs
return `409 CREATION_REGISTRATION_CHANGED` before any creation or absent-result
answer. Never replace this saved binding during recovery, even if the domain has
since been registered again or the product configuration now points elsewhere.

Both existing creation POSTs accept `Idempotency-Key`, containing 16–200 ASCII
letters, digits, `.`, `_`, `:` or `-`. Omission retains existing behavior. A
provided but invalid key is refused. The key is not a credential and must not
contain names, emails or secrets.

The namespace comprises the authenticated client-domain registration ID, verified
domain, user subject or explicit backend mode, operation kind and parent
organisation ID. Secret rotation preserves the registration; replacing a domain
registration creates a distinct namespace. Callers must not replace the original
principal or registration to retry an uncertain operation.

The request digest covers normalized effective inputs: organisation name, explicit
slug and owner; or team name, explicit slug, description and effective creator
membership flag. The transaction holds current request authority, locks the
operation, and commits resource creation, default team/memberships, audit and
receipt together. A repeated key with different inputs returns 409
`CREATION_KEY_CONFLICT`. Identical concurrent requests return the same IDs and
create one audit event. Rollback leaves neither a resource nor a receipt.

## Recovering a response

Use the original `Idempotency-Key` header and normal verified domain/config/user
credentials at:

- `GET /org/organisations/creation-status` for organisation creation.
- `GET /org/organisations/:orgId/teams/creation-status` for team creation.

Success returns `{status:"committed",organisationId,teamId}`. `teamId` identifies
the original created team or the organisation's original default team. The read
waits for an in-flight same-operation transaction to commit or roll back within
the existing transaction deadline. Status reads do not spend the creation budget.
Only `CREATION_OPERATION_NOT_FOUND` permits resending the original POST with its
original key and body. Network, timeout, rate-limit and service failures retain
the operation for bounded-backoff recovery, never a new key or name-based match.

Current authentication and membership/capabilities are checked again for every
replay and status read. A receipt is never authority. Current fields may reflect a
rename; immutable result IDs do not change. Revoked authority or an unavailable,
archived or deleted result cannot recreate the resource. The minimal receipt
contains scoped IDs and hashes, not a profile or saved response; it is permanent
and immutable, including across entity deletion. No retention sweep may reopen
its key.

Historical requests made without this contract cannot acquire a fabricated
receipt. Their missing result cannot safely be inferred from a matching name or
slug. Keep them separate from automatically retryable new operations.

## Verification and rollout

Apply additive migration `20261112150000_org_creation_recovery` before the API.
No production data backfill, secret change, native build or user sign-in is part
of this change. Verify the exact deployed capability before enabling consumers;
all serving API replicas must support it. UOA deployment alone does not update
Nessie's consumer.

On Maxis, install pinned dependencies and generate Prisma. With an isolated
PostgreSQL `DATABASE_URL` exported, run the API lint/typecheck/build, then:

```sh
pnpm --filter @uoa/api exec vitest run --maxWorkers=1 --no-file-parallelism \
  tests/integration/org-creation-recovery.test.ts \
  tests/integration/org-backend-mode-rls-organisations.test.ts \
  tests/unit/organisation.service.create-update.test.ts \
  tests/unit/team-creation-membership.test.ts \
  tests/unit/auth-create-organisation.route.test.ts \
  tests/unit/auth-create-team.route.test.ts
```

The recovery suite uses the real HTTP handlers and production RLS roles. It must
cover concurrent create, dropped-response/restart lookup, conflicting input,
cross-principal refusal, rollback after resource writes, and terminal results.
Also run a supported HTTP server with the isolated fixture, discard a successful
creation response, restart, recover by key, and inspect exactly one resource and
audit. The consuming product must exercise its actual Create form through an
interrupted response and automatic recovery before the end-to-end capability is
called complete.

Implementation and tests are a candidate until those checks pass. No runtime
verification is implied by this document.

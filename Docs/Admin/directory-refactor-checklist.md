# Directory refactor verification

Approved scope: declutter the admin directory while preserving every working operation. The user authorized revising the historical template navigation baseline.

| Capability before | Result after | Verification |
| --- | --- | --- |
| Organisation directory with unwired search | Search filters name, slug and owner email; query survives record navigation and Back | Component flow test |
| Users and teams filters in local state | URL query filters; canonical native name and related-entity links | Component tests and typecheck |
| Organisation create sends name, domain, ownerEmail | Same exact payload; removed ignored description, slug and preapproval inputs | Failure/retry and exact payload test |
| Organisation deletion | Existing confirmed mutation and protected-record refusal retained | Existing code path; no live deletion |
| Organisation whitelist and 2FA policy | Same APIs under Access tab, Members first | Component default-tab test |
| Team name/description update and whitelist | Same update APIs; Members first, Profile/Access tabs | Dedicated dialog test and typecheck |
| User/team avatar upload and removal | Same APIs under Profile; team terminology corrected | Existing avatar tests |
| User 2FA reset | Same confirmed API under Security | Code review and integrated flow tests |
| User activity filtered by email from global window | Exact-subject query supplied by orchestrator | Integrated service validation |
| Invites called preapprovals; only accepted/pending | Invitations use shared server state machine; approval separate, target team linked | Shared state-machine suite and mapping test |
| Unimplemented edit, membership, role, ownership, add-team, ban and fake delete dialogs | Removed from directory entry surfaces; no success implied | Component negative assertions/code review |

## Deliberately unresolved backend capabilities

Admin membership add/remove/role-change, ownership transfer, invitation write actions and team creation lacked working admin handlers in the starting UI. They are not replaced with unsafe product-domain calls or invented authorization. Lifecycle/deactivation/deletion work is owned by a separate ongoing task. No working mutation was removed. The existing owner-protection rules remain authoritative.

Directory APIs currently return bounded windows (100 by default). Labels describe the loaded window; filters do not imply a complete database search. Full server-side directory search/pagination is still a separate backend contract change.

No production record was modified for verification.

## Local validation (2026-10-03, Windows)

- Admin lint and typecheck passed; API typecheck passed after Prisma generation and workspace package compilation.
- Directory routing/filter/create/error tests: 6 passed.
- Team edit failure/retry and dirty-discard tests: 2 passed.
- Existing user/team avatar tests: 4 passed.
- Invitation mapping plus canonical invitation state-machine tests: 20 passed.
- Shared two-factor policy save now catches failures and retains the selected policy for retry; focused test included.
- Billing protocol package TypeScript compilation completed, but its generated-artifact check reported drift in billing-credits-v1.json in this Windows checkout. No generated schema was changed by this tranche. The orchestrator must resolve/check this in the final gate.
- Rendered browser checks and lifecycle integration are owned by the orchestrator; these local component tests do not claim live browser or production verification.

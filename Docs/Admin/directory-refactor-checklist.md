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

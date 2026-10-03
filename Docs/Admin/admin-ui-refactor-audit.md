# Admin UI refactor capability audit - 2026-10-03

This report records the approved decluttering work against integrated source revision
`1e3eff8`. It is an implementation inventory, not a claim of production deployment or
completion of the independent account/organisation/team lifecycle project. Later
integration and rendered-flow results belong in the final delivery record.

The user explicitly approved revising the main menu, linking records consistently,
removing unjustified decoration and nonfunctional controls, and preserving every working
operation. The amendments to [the template baseline](README.md) and
[the architecture](architecture-admin.md) authorize this navigation change while retaining
the existing React/Tailwind stack and authentication boundaries.

## Menu inventory

All paths below are router-relative. Production serves the app under `/admin`; the router
basename supplies that prefix. Record links must URL-encode complete website service
identifiers, including registered mount paths such as `example.com/product`.

| Menu group | Item | Route | Purpose |
| --- | --- | --- | --- |
| Home | Dashboard | `/dashboard` | Operational counts and short linked activity/error previews |
| Directory | Users | `/users` | Find a person and inspect their authoritative UOA record |
| Directory | Organisations | `/organisations` | Find organisation ownership, members, teams and access policy |
| Directory | Teams | `/teams` | Find a team across the loaded organisation directory |
| Integrations | Website services | `/domains` | Confidential website service registration and configuration |
| Integrations | Native apps | `/apps` | Registered public native clients and their policy/branding |
| Integrations | Integration requests | `/integrations` | Review incoming integrations and request history, including zero-pending state |
| Integrations | Delegation policies | `/delegations` | Explicit confidential source/product/resource/scope mappings |
| Integrations | Feature flags | `/feature-flags` | Feature app registration, flag defaults and version kill rules |
| Billing | Products & invoices | `/billing` | Product billing and a separate Contracts & invoices section |
| Security | Administrators | `/superusers` | Grant/revoke platform administrator access |
| Security | Access bans | `/bans` | Email, email-pattern, IP and user deny rules |
| Security | Automation API keys | `/api-keys` | Scoped terminal/CI access to feature flags and kill switches |
| Activity | Login activity | `/logs` | Successful-login inspection and filtered CSV export |
| Activity | Connection errors | `/connection-errors` | Sanitized handshake diagnostics and JSON export |

The menu contains 15 primary items. Native apps, website services, feature apps and billing
products remain separate registries with different authentication and commercial meanings.

## Complete route inventory

This table includes routes intentionally absent from the main menu. The source comparison
covers all 26 explicit `path` entries in [App.tsx](../../Admin/src/app/App.tsx), plus its
index route, against [navigation.ts](../../Admin/src/layouts/navigation.ts).

| Route | Screen or behavior |
| --- | --- |
| `/` | Authenticated dashboard index |
| `/login` | First-party admin sign-in |
| `/auth/callback` | First-party authorization-code/PKCE callback |
| `/dashboard` | Dashboard |
| `/apps` | Native app list/register |
| `/apps/:appId` | Native app identity, callbacks, scopes, policy and branding detail/edit |
| `/integrations` | Integration request list/history/review |
| `/domains` | Website service directory |
| `/domains/:domainId` | Website service detail |
| `/organisations` | Organisation directory/create |
| `/organisations/:orgId` | Organisation members/teams/invitations/access |
| `/organisations/:orgId/teams/:teamId` | Team members/profile/access |
| `/teams` | Cross-organisation team directory |
| `/users` | User directory |
| `/users/:userId` | User memberships/profile/security/activity |
| `/superusers` | Administrator grants/revocations |
| `/logs` | Successful-login activity |
| `/connection-errors` | Connection-error inspection |
| `/feature-flags` | Feature app directory/register |
| `/feature-flags/:appId/groups/:groupId` | Legacy audience-group URL: explicit unavailable state and return link; no fake editor |
| `/feature-flags/:appId` | Flag and kill-rule management; read-only registration settings |
| `/api-keys` | Feature-automation key metadata/create/revoke |
| `/billing` | Product billing, contracts and invoices |
| `/settings` | Compatibility redirect to `/delegations` for `tab=delegations`, otherwise `/bans` |
| `/bans` | Unified access-ban management |
| `/delegations` | Confidential delegation policy management |
| `*` | Redirect to `/dashboard` |

Detail selection uses existing route and query state rather than inventing parallel entity
models. Important query contracts are:

- Website service `tab=overview|organisations|teams|users|access|credentials|agreements|keys|email`;
  agreement selection `agreement`, and agreement section `section=evidence|audit`.
- Organisation `tab=members|teams|invitations|access`; team
  `tab=members|profile|access`; user `tab=memberships|profile|security|activity`.
- Integration requests use `status` and `request`; feature details use `tab`, `platform`,
  `flag` and `rule`; activity and automation-key inspectors use `selected`.
- Billing uses `section=contracts`, `product`, `tab`, `record`, `organisation`, `contract`
  and `invoice`. Product, contract and invoice tables have separate pagination keys.

## Capability preservation and element justification

| Area | Working operations retained | Why the remaining controls exist |
| --- | --- | --- |
| Shell and dashboard | Sign in/out; global lookup; menu navigation; current-user session guard; dashboard statistics | Search/menu reach real records; counts link to matching areas; recent items lead to inspection |
| Organisation directory | Create with exact name/domain/owner-email payload; detail read; existing confirmed delete with protected-record refusal | Creation accepts only persisted inputs; member/team/owner links expose relationships |
| Organisation detail | Whitelist update; inherited/optional/required 2FA policy update; invitation history | Access policies move to Access; invitation status and approval describe distinct server state |
| Team detail | Name/description update; whitelist update; uploaded avatar create/remove | Members are the default view; Profile and Access separate less frequent edits |
| User detail | Exact-subject read/activity; avatar upload/remove; confirmed 2FA reset | Membership links reveal relationships; Profile and Security contain their respective operations |
| Website services | Friendly-name edit; 2FA policy; email/domain allowlists; redirects; enable/disable; credential rotation by email or reveal; signing-key add/deactivate | Credentials, access and identity are distinct tasks; one-time secrets and revocation consequences stay explicit |
| Domain email | Save/register SES sender identity; refresh verification/DKIM; enable when ready; inspect DNS records | Labels distinguish the two required readiness states; DNS values support setup |
| Agreements | Retention/enforcement settings; metadata; draft upload/edit/replace/delete; publish/retire; PDF preview/download | Lifecycle and retention constraints affect legal evidence and remain visible |
| Agreement evidence/audit | Search/page/inspect/download/revoke evidence; inspect signature audit | Evidence and audit are addressable sections rather than extra unrelated page clutter |
| Native apps | Register/edit/disable; callback/scope/method/registration policy; colors; icon upload/remove | Registered public-client trust settings remain exact; detail separates inspection from editing |
| Integration requests | History/search/detail; accept/decline/delete; email/reveal credentials | Summary supports review; detailed JSON is available on demand; accepted requests link to services |
| Feature flags | Register feature app; create/edit/default toggle/delete flags; create/edit/activate/pause/delete kill rules | Each control maps to a real mutation; registration poll interval/platform remain readable |
| Product billing | Create service; immutable tariff versions/defaults; assignments; add-ons/credits; purpose-bound keys; subscription projections | Relevant section actions replace four competing create buttons; record details carry scope/provenance |
| Contracts | Create contract; append immutable versions; explicit prices/service activation; issuer create; buyer lookup/upsert | Exact contract selection and legal parties remain necessary to calculate and issue correctly |
| Invoices | Calculate exact selected contract; issue/resume; verified PDF download; payment/refund/write-off; void | Server-projected eligibility, positive exact money, idempotency and immutable evidence remain authoritative |
| Administrators | Search eligible UOA users; grant and revoke confirmed platform access | Named confirmations communicate the selected person and platform scope |
| Access bans | Create/remove email, pattern, IP and user rules; search/filter | One table makes every supported deny-rule kind discoverable |
| Automation keys | Create; one-time secret reveal; metadata inspection; revoke; optional command recipes | Scope and irreversible revocation are operationally significant; recipes are secondary |
| Activity | Date/service/method/query filters; CSV/JSON exports; event/error selection; user/service links | Filters act on the stated loaded window; UTC and diagnostics remain explicit |

Detailed before/after evidence lives in the
[directory checklist](directory-refactor-checklist.md),
[integration checklist](integrations-refactor-checklist.md), and
[billing checklist](billing-refactor-checklist.md). These separate read-only review evidence,
mocked component tests, and live browser checks; they are not interchangeable.

## Removed elements and unsupported capabilities

Removed decoration includes the inert notification bell/red dot, literal `sys_admin` label,
redundant page subtitles/counts, implementation-only system/storage explanations, billing
architecture banners and the redundant customer-safe badge. Real safety explanations for
one-time secrets, scope, revocation, irreversible changes, immutable commercial records and
retention remain.

The removed directory dialogs previously had no working admin mutation: user/org edit,
ordinary membership add/remove/role change, add-to-team, ownership transfer, team creation
from the organisation screen and invitation/preapproval writes. Org creation no longer
collects ignored description/slug/preapproval input. The fake list deletion and fake modal
2FA reset do not compete with real operations in canonical details.

Feature audience groups are not persisted by the admin API. Additional-platform registration,
feature-app settings writes and feature-app deletion likewise had no working admin write
operation. Their fake saves/confirmations are removed; the old audience route remains an
honest unavailable state. No credential fallback or product-domain bearer has been introduced
to simulate these operations.

These missing API capabilities remain gaps, not completed backend features. Restoring their
controls requires a real audited admin contract, exact scope/capability checks and appropriate
failure/retry tests. Ordinary ownership assignment must continue to exclude protected owners;
this UI refactor does not grant a new transfer/recovery authority.

## Honest data-window limits

- General directory helpers default to 100 rows and cap requested limits at 200. Organisation
  list data includes related teams/members/invites; the team directory is derived from a bounded
  organisation list and then bounded again. Client pagination cannot reach records outside that
  response.
- Website service lists use the same directory limit. Per-user memberships assembled from the
  loaded organisation directory are not a complete global membership query.
- The Login activity page explicitly requests the latest 500 successful logins. Its filters and
  CSV export cover that window, including when narrowed server-side by exact `userId`.
- User activity explicitly requests the latest 100 logs for the exact UOA subject and currently
  shows a five-event preview. It does not search global recent logs by email.
- Connection-error reads default to 100 and cap at 500; the current admin request uses the
  default. JSON export covers the loaded records only.
- Historical roster/list last-login summaries still use bounded sampled logs. Absence from that
  sample must not be treated as authoritative proof a person has never signed in. Accurate
  per-person aggregation and complete server-side directory search/pagination remain backend
  follow-up work.

The successful-login table has no invented failure events. Handshake failures remain in
Connection errors. Neither client filtering nor pagination claims database-wide completeness.

## Independent lifecycle work

A separate ongoing chat owns user/organisation/team lifecycle, suspension/deactivation,
preview/job-driven deletion, nullable/deleted identity presentation, and related authorization
changes. This report does not certify those changes as merged or deployed. The existing real
organisation delete remained at the reviewed snapshot; integration must replace/guard it as
required by that lifecycle contract rather than add a bypass.

UOA remains the sole authority for people, profiles, organisations, teams and invitations.
The refactor introduces no durable duplicate identity store, local password path or flattened
organisation hierarchy. Admin bearer authorization, native PKCE/callback policy, confidential
assertion/resource boundaries and commercial action eligibility remain server-enforced.

## Verification record and delivery gates

Observed focused evidence before this documentation tranche: directory tests covered
list/filter/detail/Back, nested service-origin return context, exact create payload and failed
retry, query failures, avatar behavior, team edits, 2FA policy errors and invitation state
mapping. Shared-dialog tests covered focus, Escape, dirty discard and pending lock. Regression
review restored diagnostic fields removed by list decluttering. Integration and billing
checklists record their own focused component/transport tests and limitations.

This documentation tranche checks every explicit router path and every menu path against the
inventory above, and resolves Markdown links in the three amended report/baseline/architecture
files. It does not rerun broad builds, browser flows or production writes. Final integrated
lint/typecheck/tests, rendered desktop/mobile flows, PR checks and deployment status remain
owned by the orchestrator. The orchestrator subsequently confirmed the local protocol artifact drift was CRLF-only:
normalizing local JSON line endings produced no content diff or schema change, and the full
recursive build passed. The orchestrator also reported 109 Admin tests, Admin lint/build and
focused API regression/typecheck/lint passing; the full API suite and expanded rendered billing
checks were still running/pending when this report was written. These reported checks do not
replace the final CI/deployment record.

## Integrated verification (2026-10-03)

- Windows: 115 Admin component/transport tests passed; Admin lint, typecheck and production build passed. The workspace recursive build also passed after normalizing local generated JSON line endings; no generated schema content changed.
- Windows Chrome: 18 synthetic browser flows passed across desktop and Pixel 7 viewports. Coverage includes every menu destination, direct record URLs, nested Back context, filters/CSV, all ban types, native edit retry/reload, nested confirmations, selected-contract calculation and invoice payment retry/idempotency. Screenshots were visually inspected. These checks do not make production mutations.
- Ubuntu (`umac`), Node 22: the complete DB-less API suite passed: 326 files, 2,105 tests; 85 DB-dependent files / 446 tests were skipped. The full workspace build passed there. This resolves Windows-only Unix-shell/file-mode/line-ending failures; three Windows timeout suites also passed when rerun with two workers (33 tests).
- New focused API checks cover exact user-ID log filtering, bounded limits, ISO timestamps, active registered-service counts and UTC day boundaries. Existing authentication/authorization tests remain in the full suite.
- Dependency audit passed the high/critical gate; moderate/low advisories remain. Diff whitespace and changed-source length checks passed.
- Database-backed integration tests, final required GitHub checks and deployment are tracked on the delivery PR. No live invoice, identity, email, signature or credential mutation was used as a test.

Final integrated review also removed redundant Cancel buttons that bypassed dirty-draft protection, guarded agreement/delegation forms, separated flag/rule pagination and reset the payment form only after a successful save. Failed payment retries retain their idempotency key and inputs.

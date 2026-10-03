# Integration UI refactor capability check

Scope: website services, native apps, integration requests, feature flags and agreement navigation.
No authentication, credential, API, persistence or entitlement contract changed.

| Existing capability | Location after | Verification |
| --- | --- | --- |
| Service search and active/disabled filter | Website services with URL q/status | True detail links; empty/error/retry states |
| Friendly-name edit | Service Overview | Same updateDomain mutation; failure visible |
| Organisation/team/user directories | Service tabs | True entity links, owner fallback/link, URL search |
| Service 2FA policy | Access tab | Same options and mutation |
| Login allowlists and extra redirects | Access tab | Existing fields and payload retained |
| Rotate credentials by email or reveal | Credentials tab | Test verifies both confirmed payloads including mounted service identifier |
| Service enable/disable | Credentials tab | Existing confirmed mutation |
| One-time secret output | Rotation/integration reveal | Existing output retained; no plaintext persisted |
| Signing key list/add/deactivate | Signing keys | Same mutations; create behind action; pending/dirty guard |
| SES save/register/refresh/enable | Email tab | Same gates; labeled Verification/DKIM; visible failures |
| Agreement retention/enforcement | Agreements tab | Same prerequisites, retention limits and operations |
| Agreement metadata and draft upload/edit/replace/delete/publish/retire/PDF preview/download | Agreements with ?agreement=id | Manager controls and services retained; failures propagate to confirmation |
| Evidence search/pagination/detail/download/revoke and audit | ?section=evidence/audit | Existing components retained; URL subsection |
| Native register/edit/disable, exact callbacks, scopes, methods, registration, colors, icon upload/remove | Native apps and /apps/:appId | Tests verify list/detail/edit exact payload, direct URL, failure/retry |
| Request history/search/detail/accept/decline/delete/email/reveal | Requests with ?status=&request= | Existing mutations; accepted service link; JSON disclosure; pending lock |
| Feature app registration | Feature flags | Same validated creation; failure retains input |
| Flag create/edit/default toggle/delete | ?tab=flags&flag=id | Tests verify addressable edit payload and confirmed deletion |
| Kill-rule create/edit/activate/pause/delete | ?tab=killswitches&rule=id | All rule fields and mutations retained; bare platform key labels fixed |
| Poll interval | ?tab=settings | Tested read-only registration settings |

## Unsupported controls

The API returns no persisted feature audience groups and offers no admin writes for additional
platforms, app settings or app deletion. Removed their fake saves/confirmations; the legacy
audience URL explains availability and links back. No stored capability or model was removed.

## Validation

Focused Vitest after shared integration: 11 tests pass across new native-app, website credential,
feature-detail tests and existing audience filtering tests. Tests use mocked API boundaries.
TypeScript, ESLint and production Vite build pass after shared primitive integration. Vite reports the existing large main-chunk advisory.
No production writes or mail sends. Browser/mobile and connected end-to-end checks remain the
orchestrator integration gate. Agreement/evidence controls retained by source review; no live
signature test records created.

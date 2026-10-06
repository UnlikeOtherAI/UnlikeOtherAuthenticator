# First-party Admin debug login verification

The owning surfaces are the authenticated shell's bottom-right Debug login button
and the same button on `/admin/login`. Google sign-in is an explicit button so
operators can reach the importer. The contract is in
[Admin architecture](../Admin/architecture-admin.md#2026-10-06-first-party-admin-debug-login).

## Focused commands

Build the two local packages, generate Prisma, and build Auth before the API auth
render regression tests. Supply a dedicated local PostgreSQL DATABASE_URL through
the process environment; never point this suite at production. The test harness
migrates and deletes only its uniquely named schemas.

```sh
pnpm --filter @unlikeotherai/billing-statement-protocol build
pnpm --filter @unlikeotherai/slug build
pnpm --filter @uoa/api exec prisma generate
pnpm --filter @uoa/auth build
pnpm --filter @uoa/api exec vitest run tests/integration/admin-debug-login.test.ts tests/integration/debug-login.test.ts tests/unit/internal-admin-token.route.test.ts tests/integration/internal-admin-auth.test.ts --maxWorkers=1 --fileParallelism=false
pnpm --filter @uoa/admin exec vitest run src/components/DebugFab.test.tsx src/services/admin-debug-login-service.test.ts src/features/auth/admin-session.test.tsx src/layouts/Sidebar.test.tsx
pnpm --filter @uoa/admin build
UOA_DEBUG_EVIDENCE_DIR=<durable-directory-outside-worktree> pnpm --filter @uoa/admin exec playwright test --config playwright.debug-login.config.ts
```

The headless browser suite serves the production build with no auth bypass,
uses synthetic API fixtures, checks desktop/mobile rendering and JSON/bare-code
import, destination rejection, clipboard keys, renewal and replay error retention.
Its screenshots are fixture rendering evidence, not live identity redemption.
Real PostgreSQL integration tests separately verify the ordinary PKCE admin
exchange installs its ownership cookie, issue/redemption reaches durable state,
concurrent redemption has one winner, families differ, logout remains independent,
current role loss fails closed, source-cookie mismatches and product bearers fail,
and wrong origins/config URLs are refused. The existing debug core suite exercises
source expiry, epoch revocation, membership/2FA policy, renewal and family races.

## 2026-10-06 local result

API and Admin lint/type checks, Auth/Admin production builds, focused server and
frontend tests and all four production-build browser flows passed on macOS.
Screenshots were visually inspected on desktop and mobile. No deployment or
production write is claimed by this local verification.

The full Admin suite has five pre-existing billing failures, reproduced on the
untouched base revision `78841b8d`: four BillingContractsPanel tests omit the
useBillingCycleCorrectionsQuery mock and one BillingPage test expects the removed
Stripe subscriptions selector. The parent integration run owns CI/deployment.

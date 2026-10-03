# Admin browser regression checks

These tests run the real React UI against isolated synthetic API fixtures. No login credentials,
production API calls, database, email or payment runtime are used. Every external request is
blocked; unknown API reads and every unlisted mutation are recorded and fail the checks.
Only explicitly modeled native-app saves, invoice calculations and payment retries are accepted.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @uoa/admin exec playwright install chromium
pnpm --filter @uoa/admin test:e2e
```

If Chrome is already installed, set `PW_CHANNEL=chrome` to reuse it instead of downloading
Chromium. In PowerShell: `$env:PW_CHANNEL='chrome'` before the test command.

The harness starts its own Vite server on **127.0.0.1:5274** with the existing development-only
auth bypass. The port must be free. It never reuses an unknown server. Playwright stops its
server at suite completion. Run one suite at a time; concurrency is fixed at one worker.
Production builds cannot enable this bypass (`import.meta.env.DEV` remains required).

## Coverage

Both desktop (1440x1000) and Pixel 7 mobile viewports:

- Every sidebar destination, including integration history with zero pending requests.
- Exact record URLs and service subsections, so catch-all redirects fail the test.
- Service search, empty result, list-to-detail-to-related user and browser Back with preserved filters.
- Multi-hop record Back buttons returning through the exact service tab/search to its filtered list.
- Native-app header Back preserves the filtered app list.
- Native app direct detail/edit, failed save retaining input, successful retry and reload.
- Modal Escape/unsaved-change guard, Tab/Shift-Tab containment and restored focus.
- Activity date/method/search filters, filtered CSV content, selection excluded by filtering.
- Connection error selection excluded by filtering.
- Email/pattern/IP/user ban visibility and filtering.
- Nested credential confirmation dismissal retains the underlying request review.
- Billing product detail, contract selection/calculator payload, invoice selection and related organisation Back.
- Invoice server-authored action guards and amount cap; failed payment retry retains its idempotency key, successful save clears dirty state.
- No uncaught page errors, unexpected fixture endpoints or document-level horizontal overflow.

Fixtures include populated directories/services/flags/contracts/invoices and empty signature evidence histories. These are UI regressions, not proof of authorization, backend persistence, PDF
generation, SES delivery, payment processing or real-device behavior. Existing API/unit tests
remain responsible for those contracts. Failed browser runs save screenshots and traces under
`e2e/artifacts` (ignored by Git).

## Recorded validation

2026-10-03, Windows, installed Chrome: the initial 12 checks passed (six cases on both viewports).
The expanded suite includes nine cases per viewport; its final result is recorded below.

Final expanded run: **18/18 passed** (nine cases on both viewports) on integration revision
`8c050be`, 2026-10-03, Windows installed Chrome, one worker, approximately 1.1 minutes.
Admin TypeScript and ESLint also passed; the focused invoice/feature pagination component suite
passed all nine tests. Desktop/mobile native detail screenshots are retained under the ignored
artifacts directory. These checks found and fixed stale successful-payment dirty state and
missing return context; they do not claim live backend or provider verification.

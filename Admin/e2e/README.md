# Admin browser regression checks

These tests run the real React UI against isolated synthetic API fixtures. No login credentials,
production API calls, database, email or payment runtime are used. Every external request is
blocked; unknown API reads and every unlisted mutation are recorded and fail the checks.
Only the fixture native-app PUT is accepted, to verify failed-save retry and reload persistence.

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
- Record Back button returning to the exact source service tab and search.
- Native app direct detail/edit, failed save retaining input, successful retry and reload.
- Modal Escape/unsaved-change guard, Tab/Shift-Tab containment and restored focus.
- Activity date/method/search filters, filtered CSV content, selection excluded by filtering.
- Connection error selection excluded by filtering.
- Email/pattern/IP/user ban visibility and filtering.
- No uncaught page errors, unexpected fixture endpoints or document-level horizontal overflow.

Fixtures include populated directories/services/flags and empty specialist billing/signature
histories. These are UI regressions, not proof of authorization, backend persistence, PDF
generation, SES delivery, payment processing or real-device behavior. Existing API/unit tests
remain responsible for those contracts. Failed browser runs save screenshots and traces under
`e2e/artifacts` (ignored by Git).

## Recorded validation

2026-10-03, Windows, installed Chrome: the initial 12 checks passed (six cases on both viewports).
The new source-context Back-button regression is verified after the directory allowlist change.

# Browser team entry: before and after

After one completed social sign-in, an eligible exact-team browser entry needs
zero manual actions in UOA. The baseline requires a provider click and a team
click. Both versions complete the provider roundtrip and exchange a separate
target code. The source family keeps its original scope, assurance ID, expiry
and revocation state.

These 22 screenshots come from the actual built Auth HTML/React and UOA routes,
running headless Chromium on Maxis on 2026-10-24. Every comparison uses the same
light theme, configuration, team names and viewport: desktop 1280 × 900 or mobile
390 × 900. The browser checks assert no horizontal overflow and no page errors.

## Revisions and limits

- Before: product sources at `ee2bf654`; verification branch `b418d075` adds only
  the browser probe. The API and Auth implementation remain at the baseline.
- After: `aaaf6930`, including the final browser probe and contract documentation.
- Signed configuration and Google HTTP responses are explicit local fixtures.
  UOA still verifies signed browser state, its nonce cookie and PKCE, resolves
  current membership, issues the authorization code and exchanges it through its
  real routes against an isolated PostgreSQL schema.
- No screenshot claims to show Google's UI. The source/target completion screens
  are labelled **Local integration fixture**: they confirm the real code exchange
  and exact active team, and do not show Nessie's product UI. Live Google and the
  complete Nessie journey require separate integration verification.
- The cancellation screen is the existing generic HTTP 401 page in both versions.
  The next explicit entry shows normal provider choices. No automatic retry or
  new token grant follows cancellation.
- No production accounts, data or settings were changed. Native verification is
  deferred; this evidence covers browser entry only.

## Journey and screenshot inventory

The first completed source sign-in establishes the provider preference in the
After version. The person then starts a new target-team entry. After skips the
provider-choice screen and preserves the team hint through signed state, so its
verified chooser immediately shows the existing “Signing you in...” state.
No new screen replaces the skipped provider-choice screen.

### Desktop: 1280 × 900

| Order and state | Before | After |
| --- | --- | --- |
| 0. Source sign-in completed; labelled callback fixture | [Source completion](before/1280-00-source-completed-fixture.png) | [Source completion](after/1280-00-source-completed-fixture.png) |
| 1. New target entry reaches provider choice | [Provider choice](before/1280-01-provider-choice.png) | Not rendered; the existing social-provider roundtrip starts automatically |
| 2. Target team selection or automatic opening | [Team choice](before/1280-02-team-choice.png) | [Signing you in](after/1280-02-opening-team.png) |
| 3. Exact target sign-in completed; labelled callback fixture | [Target completion](before/1280-03-target-completed-fixture.png) | [Target completion](after/1280-03-target-completed-fixture.png) |
| 4. A subsequent provider attempt is cancelled | [Existing cancellation page](before/1280-03b-provider-cancelled.png) | [Existing cancellation page](after/1280-03b-provider-cancelled.png) |
| 5. Next explicit entry returns to provider choices | [Retry choices](before/1280-04-cancelled-retry-choice.png) | [Retry choices](after/1280-04-cancelled-retry-choice.png) |

### Mobile: 390 × 900

| Order and state | Before | After |
| --- | --- | --- |
| 0. Source sign-in completed; labelled callback fixture | [Source completion](before/390-00-source-completed-fixture.png) | [Source completion](after/390-00-source-completed-fixture.png) |
| 1. New target entry reaches provider choice | [Provider choice](before/390-01-provider-choice.png) | Not rendered; the existing social-provider roundtrip starts automatically |
| 2. Target team selection or automatic opening | [Team choice](before/390-02-team-choice.png) | [Signing you in](after/390-02-opening-team.png) |
| 3. Exact target sign-in completed; labelled callback fixture | [Target completion](before/390-03-target-completed-fixture.png) | [Target completion](after/390-03-target-completed-fixture.png) |
| 4. A subsequent provider attempt is cancelled | [Existing cancellation page](before/390-03b-provider-cancelled.png) | [Existing cancellation page](after/390-03b-provider-cancelled.png) |
| 5. Next explicit entry returns to provider choices | [Retry choices](before/390-04-cancelled-retry-choice.png) | [Retry choices](after/390-04-cancelled-retry-choice.png) |

## Verification

Passed on Maxis:

- 58 focused API unit cases, including signed provider preference, excluded entry
  types, state roundtrip, callback, factor and signature completion.
- One database journey covering the original code exchange/refresh, remembered
  provider entry, a new nonce-bound callback, preserved hint, target selection
  and separate target token issuance while retaining the source family.
- 25 Auth team-response unit cases, including foreign hints and ambiguous slugs.
- API typecheck, Auth client/SSR build and changed-source ESLint.
- Four headless browser cases: Before and After at both viewports. Each completes
  first sign-in, target entry, provider cancellation and the next explicit retry.
  Target entry requires two manual actions Before and zero After.

The explicit browser command is separate from ordinary tests and CI:

```sh
PLAYWRIGHT_MODULE=<existing-playwright-index.mjs> pnpm --filter @uoa/auth exec vitest run --config vitest.social-entry.config.ts
```

Run it with an isolated `DATABASE_URL`, after building Auth. Set
`UOA_SOCIAL_ENTRY_STAGE=before` in the baseline checkout; the default is `after`.
The focused API/Auth commands and fixture contract are documented in
[`Docs/Auth/enterprise-sso.md`](../../Auth/enterprise-sso.md#browser-team-reauthorization).

The raw verification logs retain earlier runner failures and the successful
reruns: a local stdout encoding issue, an incorrectly inherited admin database
URL, and a probe-only cancellation-navigation wait were corrected. These were
not production authority failures. Sanitized logs and per-viewport JSON results
are preserved outside the worktrees at
`C:/Users/ondre/.nessie/evidence/login-recovery-20261024/uoa` on Maxis.

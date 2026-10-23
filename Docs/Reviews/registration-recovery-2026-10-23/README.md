# Registration recovery screens — 23 October 2026

Follow-up to the cross-device registration work in #123 and #124. Three
recovery states told people to do something that could not work, or hid the
way forward.

| State | Before | After |
| --- | --- | --- |
| Rejected email link (expired, exhausted or malformed) | Kept the **Verify email address** button and said "Try again" — a rejected link can never succeed on retry | Says the link has expired or is no longer valid and removes the button. Only a network failure, 429 or 5xx keeps the button and asks to try again. Replaying an already-used link is unchanged: the API stays idempotent (200) and the page shows success |
| Link without its secret | Same message, but the button stayed and did nothing new | Same message, button removed |
| Confirmation success | The result line sat inside the removed button's row, leaving a large gap under the body text | The page template has an optional status region below the actions; success shows heading, body and the continuation sentence without the gap |
| Pending registration expired (code screen) | Kept "We've sent a link and code… open the link or enter the code below" above the expiry message; the only way on was a small text link | Shows the expiry message and a primary **Request a new email** button |

Before screenshots are the #124 set in
[`../registration-continuation-2026-10-22/`](../registration-continuation-2026-10-22/)
(`*-registration-expired.png`, `*-link-error.png`, `*-link-missing-secret.png`,
`*-cross-device-success.png`). After screenshots are in this folder.

## Validation

- `Admin/playwright.registration.config.ts` with system Chrome
  (`PW_CHANNEL=chrome`): 20 passed, 2 skipped (the env-gated base-revision
  captures), desktop and Pixel 7. New assertions: expired instructions hidden,
  503 keeps the retry, 400 removes the button and never says "Try again",
  missing secret removes the button, and the success sentence sits within
  20 px of the body text.
- Auth unit tests: 174 passed. API typecheck passed. ESLint clean on the
  changed files.
- API unit suite (DB-less) on a heavily loaded local machine: 2,660 passed,
  19 failed, all 30-second timeouts in route tests that differ between runs.
  The one repeatable timeout (`GET /auth/email/link` "already used") also times
  out with `main`'s versions of both changed files, so it is not caused by this
  change. CI is the reference run.

# Cross-device registration continuation — 22 October 2026

Confirming the email link on another device now approves its exact original
pending registration. The original screen receives the WebSocket hint, rechecks
state with its HttpOnly cookie and original OAuth context, and advances without
code entry. The confirming browser receives only success: no login cookie,
completion proof or redirect. Codes remain an alternative bound to the original
flow. Explicit confirmation approves that initiating request; GET and previews
have no effect, and replay cannot approve a different registration.

An approval arriving during a WebSocket status read immediately triggers another
read. It no longer waits for the fallback timer. Other replicas retain the existing
five-second database recheck, and blocked sockets retain the client polling fallback.

## Validation

On Windows Maxis:

- Workspace production build, final API build and API typecheck passed.
- Twelve PostgreSQL integration cases passed, including cross-device approval,
  socket notification, original-cookie/OAuth binding, confirming-browser isolation,
  one-use completion, replay, code attempts and expiry.
- Three focused unit tests passed, including approval during an in-flight status
  read with the polling clock stopped.
- Fourteen desktop/Pixel 7 browser checks passed before expanding state coverage.
- API/Admin lint and OpenAPI validation passed; OpenAPI retains existing warnings.

The final expanded browser suite ran locally on Windows Minis because Maxis was
busy with other workloads. The Auth production build, Admin lint and all twenty
desktop/Pixel 7 checks passed. Two isolated browser contexts confirm the original
screen advances without submitting a code or advancing the polling clock, while
the confirming context has no cookies or redirect. A separate same-browser test
uses two tabs and checks the original registration cookie is present. Loading,
error, expiry, resend and code-entry states are captured from the actual bundle.

Browser responses are synthetic; persistence tests use real isolated PostgreSQL
schemas. Live mail delivery and physical phone/Safari testing were not performed.
No native app source or dependency graph changed. No new migration is required.

## Rendered evidence

Before uses the actual confirmation HTML served by production revision `1d7e3fe1`
before the correction. After uses the final server renderer. Each pair has the
same state and viewport: 1024 × 768 desktop and Pixel 7 mobile emulation.

| Surface | Before | After |
| --- | --- | --- |
| Desktop confirmation | [Before](desktop-before-confirmation.png) | [After](desktop-after-confirmation.png) |
| Mobile confirmation | [Before](mobile-before-confirmation.png) | [After](mobile-after-confirmation.png) |
| Desktop success | [Before](desktop-before-success.png) | [After](desktop-cross-device-success.png) |
| Mobile success | [Before](mobile-before-success.png) | [After](mobile-cross-device-success.png) |
| Desktop original browser after cross-device approval | [Before](desktop-before-original-continued.png) | [After](desktop-cross-device-original-continued.png) |
| Mobile original browser after cross-device approval | [Before](mobile-before-original-continued.png) | [After](mobile-cross-device-original-continued.png) |
| Desktop link verifying | [Before](desktop-before-link-verifying.png) | [After](desktop-link-verifying.png) |
| Mobile link verifying | [Before](mobile-before-link-verifying.png) | [After](mobile-link-verifying.png) |
| Desktop link rejected | [Before](desktop-before-link-error.png) | [After](desktop-link-error.png) |
| Mobile link rejected | [Before](mobile-before-link-error.png) | [After](mobile-link-error.png) |
| Desktop link missing secret | [Before](desktop-before-link-missing-secret.png) | [After](desktop-link-missing-secret.png) |
| Mobile link missing secret | [Before](mobile-before-link-missing-secret.png) | [After](mobile-link-missing-secret.png) |

The original-browser Before uses the unchanged Auth source from `1d7e3fe1` with
that revision's `verified` response. It shows the code requirement removed by
#124. The After uses the new `authorized` response and reaches password setup.

The original screen after confirmation is captured for
[desktop](desktop-original-continued.png) and [mobile](mobile-original-continued.png).
The confirming browser's success page is captured for
[desktop](desktop-cross-device-success.png) and [mobile](mobile-cross-device-success.png).

## Screen and state inventory

Every row below has desktop and mobile screenshots embedded directly in the PR
description. The email and code-entry UI was introduced in #123 and is unchanged
by #124. The new code-entry states had no equivalent before #123; its description
also embeds the original registration and email Before/After pairs. #124's pairs
above compare its changed confirmation and success copy with #123's deployed HTML.
Password setup is unchanged and included as the destination after verification.

| Journey | Captures (each has `desktop-` and `mobile-` versions) |
| --- | --- |
| Submit email, wait for verification | `after-registration.png`, `after-email.png` |
| Confirm in the same browser | `same-browser-confirmation.png`, `same-browser-success.png`, `same-browser-original-continued.png` |
| Confirm on another device | `after-confirmation.png`, `cross-device-success.png`, `cross-device-original-continued.png` |
| Enter the optional code | `partial-code.png`, `code-verifying.png`, `code-original-continued.png` |
| Recover from an incorrect code | `invalid-code.png` |
| Resend or recover from expiry | `resend-loading.png`, `registration-expired.png`, `resend-failed.png` |
| Link verification in progress, rejected or missing its secret | `link-verifying.png`, `link-error.png`, `link-missing-secret.png` |

Fixtures use synthetic link secrets and `person@example.com`; no real account or
mailbox appears in the images. The full-page captures use matching light themes,
1024 × 768 desktop and Pixel 7 mobile emulation (393 × 800 CSS pixels).

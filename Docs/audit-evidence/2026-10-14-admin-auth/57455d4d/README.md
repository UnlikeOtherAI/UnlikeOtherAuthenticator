# Fresh validation of 57455d4d

Maxis, 14 October 2026. Application source 57455d4dab448999a8d7b8b44a9877515e7cc9be.
Final local headless Chromium run: 26 passed, no failures, skips or retries, one worker,
40.2 seconds. Desktop Chrome and Pixel 7 profiles. All 26 screenshots below were visually
inspected after fonts and images settled. All credentials, codes and identities are synthetic.

| State | Desktop | Mobile |
| --- | --- | --- |
| Active domain reveal after stale-response navigation test | [Desktop](desktop-domain-active-reveal.png) | [Mobile](mobile-domain-active-reveal.png) |
| Active product key after stale-response tab test | [Desktop](desktop-product-active-reveal.png) | [Mobile](mobile-product-active-reveal.png) |
| Automation response after session clearing | [Desktop](desktop-automation-cleared-login.png) | [Mobile](mobile-automation-cleared-login.png) |
| Automation hook lifecycle fixture | [Desktop](desktop-automation-settled-lifecycle.png) | [Mobile](mobile-automation-settled-lifecycle.png) |
| Product hook lifecycle fixture | [Desktop](desktop-product-settled-lifecycle.png) | [Mobile](mobile-product-settled-lifecycle.png) |
| Legitimate fresh login after rejected stale validation | [Desktop](desktop-fresh-sign-in.png) | [Mobile](mobile-fresh-sign-in.png) |
| Same-owner StrictMode login positive | [Desktop](desktop-strict-owner-sign-in.png) | [Mobile](mobile-strict-owner-sign-in.png) |
| Email-code recovery | [Desktop](desktop-email-code-retry.png) | [Mobile](mobile-email-code-retry.png) |
| Expiry returns to login | [Desktop](desktop-expired-session-login.png) | [Mobile](mobile-expired-session-login.png) |
| Registered callback handoff | [Desktop](desktop-native-handoff.png) | [Mobile](mobile-native-handoff.png) |
| Saved native app with icon retry | [Desktop](desktop-native-icon-retry.png) | [Mobile](mobile-native-icon-retry.png) |
| Active automation key and close/navigation | [Desktop](desktop-one-time-key-reveal.png) | [Mobile](mobile-one-time-key-reveal.png) |
| PDF source actions | [Desktop](desktop-pdf-preview-source-screen.png) | [Mobile](mobile-pdf-preview-source-screen.png) |

The local lifecycle fixture exercises real hooks/provider code. Its external close/reopen and
unmount/remount controls are test mechanisms; production issuance dialogs still block pending
dismissal. Session clearing tests the notification/teardown boundary, not live provider logout.
PDF assertions separately verify protected bytes, detached opener, source download completion
and failed/blocked popup recovery. Screenshots show the source surface, not the native PDF viewer.

Run and command evidence is in the [scoped report](../../../plans/2026-10-14-admin-auth-audit-remediation.md).
All issues remain open for parent acceptance.

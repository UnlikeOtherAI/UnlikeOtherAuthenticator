# Admin/Auth browser evidence

Maxis, 14 October 2026. All 12 audit journeys passed with one worker in Chromium 145 new headless;
desktop Chrome and Pixel 7 mobile profiles. Every screenshot below was visually inspected.
Data, callback codes and credential values are synthetic browser-test fixtures.

Fresh validation of the later correction is preserved separately in the
[57455d4d evidence index](57455d4d/README.md): 26 desktop/mobile journeys, including deferred U-18
responses and U-37 session completion. The screenshots below belong to the preceding checkpoint.

| Reviewed state | Desktop | Mobile |
| --- | --- | --- |
| Email-code failure and resend recovery | [Desktop](desktop-email-code-retry.png) | [Mobile](mobile-email-code-retry.png) |
| Expiry returns to usable login | [Desktop](desktop-expired-session-login.png) | [Mobile](mobile-expired-session-login.png) |
| Registered callback handoff | [Desktop](desktop-native-handoff.png) | [Mobile](mobile-native-handoff.png) |
| Saved native app with failed icon upload and retry | [Desktop](desktop-native-icon-retry.png) | [Mobile](mobile-native-icon-retry.png) |
| One-time credential reveal | [Desktop](desktop-one-time-key-reveal.png) | [Mobile](mobile-one-time-key-reveal.png) |
| PDF source remains available after recovery checks | [Desktop](desktop-pdf-preview-source-screen.png) | [Mobile](mobile-pdf-preview-source-screen.png) |

The PDF journey separately asserts authenticated PDF bytes at the blob URL, `window.opener === null`,
failed-preview tab closure and a blocked-preview retry without fetching first. The source screenshot
documents the operator's recovery surface; it does not depict the PDF viewer itself.

Run from the worktree with the pinned browser installed:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=5120'
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path (Get-Location) 'node_modules/.cache/ms-playwright'
pnpm --filter @uoa/admin exec playwright test --config=playwright.audit.config.ts
```

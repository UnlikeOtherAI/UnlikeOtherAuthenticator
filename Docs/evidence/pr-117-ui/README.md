# Organisation sign-in doorway

Matching 390 × 900 and 1280 × 900 screenshots use the same owner, two-team
response and English configuration. Before renders main `33a3501a`; After
renders `b6bc8c73`. API responses are browser fixtures; these images prove the
actual UI and doorway, not identity-provider or production readiness.

Run `Auth/e2e/owner-chooser-evidence.mjs` from the repository root with the two
Auth Vite servers named by `UOA_AUTH_PREVIEW_BEFORE` and
`UOA_AUTH_PREVIEW_AFTER`. `PLAYWRIGHT_MODULE` selects the installed Playwright
entry; `PLAYWRIGHT_CHANNEL=msedge` reuses Edge on Maxis. The script runs headless,
checks for page errors and horizontal overflow, and saves both viewport pairs.

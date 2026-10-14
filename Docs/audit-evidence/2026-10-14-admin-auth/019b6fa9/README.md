# U-10 Members validation

Application source: 019b6fa98956d9a7271be24b27af8e20090e65c9. Maxis, 14 October 2026.
Admin typecheck/build passed. Local Chromium desktop + Pixel 7: **2 passed**, no failures,
skips or retries, one worker, 9.0 seconds. All six settled screenshots were visually inspected.
Data is synthetic; no live provider, database or authority-changing write was used.

| Surface | Desktop | Phone |
| --- | --- | --- |
| Owner and disabled-account rows, independent states | [Desktop](desktop-members-independent-statuses.png) | [Phone](mobile-members-independent-statuses.png) |
| Removed, deactivated and missing-membership state | [Desktop](desktop-members-removed-unknown-states.png) | [Phone](mobile-members-removed-unknown-states.png) |
| Existing disabled-account recovery doorway | [Desktop](desktop-disabled-member-recovery.png) | [Phone](mobile-disabled-member-recovery.png) |

Phone table columns use the existing horizontal scroll container. Lower rows and recovery use
vertical scrolling; captures intentionally show both viewport positions. Account status remains
independent of membership, and missing membership state reads Unavailable. Role, canonical user
link and removed-member team navigation are asserted. Recovery is visible in the viewport, but
the test does not submit reactivation or claim live authorization/backend verification.

The earlier 24 focused tests passed on this same application input and were not repeated.
Commands, build warning, fixture limits and slot release are in the
[scoped report](../../../plans/2026-10-14-admin-auth-audit-remediation.md).
U-10 remains open pending parent acceptance of the combined API/Admin change.

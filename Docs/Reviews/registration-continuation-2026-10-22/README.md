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
- Fourteen desktop/Pixel 7 browser checks passed. Two isolated browser contexts
  confirm the original screen advances without submitting a code or advancing
  the polling clock, while the confirming context has no cookies or redirect.
- API/Admin lint and OpenAPI validation passed; OpenAPI retains existing warnings.

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

The original screen after confirmation is captured for
[desktop](desktop-original-continued.png) and [mobile](mobile-original-continued.png).
The confirming browser's success page is captured for
[desktop](desktop-cross-device-success.png) and [mobile](mobile-cross-device-success.png).

# Registration verification checks — 22 October 2026

The code-after-link behavior recorded below was superseded by the
[cross-device continuation clarification](../registration-continuation-2026-10-22/README.md).
The original screen now advances after explicit confirmation on any device,
without requiring the code. This earlier validation record is retained as history.

The hosted registration screen now offers one email link and a six-character
uppercase code. The code belongs to the requesting browser's pending flow.
The link confirms the mailbox on any device without signing that device in.
A same-browser confirmation can advance its own flow. After a cross-device
confirmation, the original browser still needs the emailed code; otherwise an
attacker could start registration with a victim's address and benefit from a click.
No separate pairing code is introduced.

The database stores credential digests, a verified client domain, an immutable
OAuth/config digest, attempt counts and proof timestamps. HttpOnly cookies own
pending flows. Five failed guesses exhaust a code. Verification is serialized
across processes; the existing one-use account/code writer completes registration.
WebSocket messages contain only a verification hint. Connected replicas recheck
database state every five seconds; clients recheck on load/reconnect/focus and
retain a ten-second polling fallback. Refresh and resend preserve the address.

## Validation

Portable builds, tests and browser checks ran on Windows Maxis. No native app
source or build graph changed, so no native build was needed.

- Workspace production build and API TypeScript check passed.
- API unit suite: 2,650 passed, three pre-existing skips.
- Auth unit/component suite: 174 passed, including segmented entry, paste,
  autofill, focus, editing, backspace and automatic completion.
- PostgreSQL registration/funnel/legacy verification checks: 21 passed, including
  12 pending-flow cases for cross-device isolation, missing/wrong browser
  credentials, exact OAuth binding, persisted guess exhaustion, expiry,
  link/code races, link replay, authenticated WebSockets, single account/code
  creation and retained funnel counters.
- Sixteen desktop and Pixel 7 emulation checks exercise the built Auth bundle: registration,
  bad-code recovery, automatic completion, refresh, resend, WebSocket updates,
  polling fallback, cross-device success, and email readability.
- Auth/API/Admin lint passed. OpenAPI validation passed with warnings.

Browser responses are synthetic; persistence/security checks use real isolated
PostgreSQL schemas. Live email delivery and physical phone/Safari testing were
not performed. Deployment must apply the pending-registration migration with
the API/Auth release. The hosted flow requires no product-config opt-in.

## Rendered evidence

Before registration screenshots use the actual Auth bundle from `87216f62`.
The later metrics-only main update did not change that Auth UI. Before email
screenshots use the previous unchanged email template and its original link
shape. Every pair uses the same synthetic address/theme, state and viewport.

| Surface | Before | After |
| --- | --- | --- |
| Desktop registration, 1024 × 768 | [Before](desktop-before-registration.png) | [After](desktop-after-registration.png) |
| Mobile registration, Pixel 7 | [Before](mobile-before-registration.png) | [After](mobile-after-registration.png) |
| Desktop email | [Before](desktop-before-email.png) | [After](desktop-after-email.png) |
| Mobile email | [Before](mobile-before-email.png) | [After](mobile-after-email.png) |

The independent confirmation view is captured for
[desktop](desktop-cross-device-success.png) and
[mobile](mobile-cross-device-success.png). It removes the confirmation button
after success, explains where to continue, and issues no login or redirect.

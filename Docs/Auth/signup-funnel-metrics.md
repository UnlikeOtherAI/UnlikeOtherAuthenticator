# Sign-up and sign-in funnel metrics

Added 2026-10-22 so the owner can see where people sent to UOA by a product stop. The trigger was
Hugo: of the people Hugo sends to UOA to register, a large share never come back, and nothing in UOA
recorded which step they left at. Verification tokens are pruned once they expire and registration
emails cannot be told apart per client in SES, so this cannot be reconstructed for the past;
measuring starts when this ships.

## What is recorded

One counter per **UTC day × client domain × step × outcome**, incremented once per event. The client
domain is the verified `domain` of the product's signed config. Nothing else is stored: no email,
IP address, user id, token, authorization code or flow id. Counts are events, not people: reloading
the window or submitting the form twice counts twice.

| Step | Recorded when | Outcomes |
| --- | --- | --- |
| `flow_started` | `GET /auth` renders the window for a product starting a flow. Mid-flow re-renders (2FA, team chooser, invite, email-token continuations) are not counted; a manual reload after the Auth window has stripped its continuation token can be. | `shown` |
| `register_submitted` | `POST /auth/register` (the "Create account" form). | `valid_email`, `invalid_email` |
| `email_start_submitted` | `POST /auth/start` (email-first form, products with email codes). | `valid_email`, `invalid_email` |
| `login_submitted` | `POST /auth/login` (email + password). | `succeeded` (credentials accepted; 2FA or a team choice may still follow), `failed` |
| `registration_email` | What UOA did with a submitted address behind the generic reply. `*_sent` means the email provider accepted the message, not that it arrived. | `verification_sent`, `verification_failed`, `login_link_sent`, `login_link_failed` (existing account), `existing_user_inline` (product opted into `inline_sign_in`; no email), `blocked` (registration not allowed or banned; no email), `error` |
| `email_link_opened` | `GET /auth/email/link`, the link in that email. `HEAD` requests (mail scanners pre-checking links) are not counted. Team invitations share this route and are kept apart. | `valid_set_password`, `valid_verify_email`, `valid_login_link`, `expired`, `already_used`, `invalid` (unknown, wrong client, or already pruned), `invalid_pkce` / `missing_pkce` (damaged link), `invite`, `invite_unavailable` |
| `set_password` | `POST /auth/verify-email` from the set-password (or invite registration) form. | `succeeded` (set-password token: account created), `succeeded_<token type>` (another token type, only from direct API calls), `password_rejected`, `expired`, `already_used`, `failed` |
| `social_started` | `GET /auth/social/:provider` redirects to the provider. | provider key (`google`, `apple`, …) |
| `sign_in_completed` | A sign-in finished: UOA returned an authorization code, recorded an access request, or accepted a team invitation through social sign-in. Recorded with the login log, so each password, email-link, email-code and social sign-in counts once, after any 2FA or team choice. Enterprise organisation SSO writes no login log and is not counted here. | auth method (`email_password`, `verify_email_set_password`, `login_link`, `google`, `email_code`, …) |
| `code_exchange` | The product backend redeems the code at `POST /auth/token` (`authorization_code` grant). | `succeeded`, `rejected_<reason>` (the internal reason behind the opaque `INVALID_AUTH_CODE`: `code_not_found`, `expired`, `already_used`, `pkce_verifier_invalid`, `redirect_url_mismatch`, …), `failed` |

Outcomes are server-chosen identifiers; anything that does not match `^[a-z0-9_]{1,64}$` is stored
as `other`. Public responses are unchanged: no outcome or rejection reason is ever returned to a
caller.

## Reading it

- **Admin:** Activity → **Sign-up funnel** (`/admin/signup-funnel`). Period (UTC) and service
  filters; a step table with how many reached each step, the share of opened windows, and every
  outcome; and a per-day table.
- **API:** `GET /internal/admin/auth-funnel?from=YYYY-MM-DD&to=YYYY-MM-DD&domain=<client domain>`
  with an admin-domain superuser bearer. Default range is the last 30 UTC days; at most 366 days.
  Contract in `/api`.

## Storage and failure behaviour

Table `auth_funnel_daily_counts`, primary key `(day, domain, step, outcome)`. It is admin-only like
the other log tables: forced RLS, deny-all policy and `REVOKE ALL` for `uoa_app`; written and read
through the BYPASSRLS admin client. Each event is one upsert-increment.

Recording is best-effort and never part of an authentication decision. It runs after the step's own
work, outside every authentication transaction, and a failed write is logged and swallowed, so a
metrics outage cannot change a sign-in outcome or response. A step waits at most one second for its
write; a slower write finishes in the background. The counters hold no personal data and
are not pruned.

## What a new person must do in UOA (as of 2026-10-22)

For a product configured like Hugo (`enabled_auth_methods: ["email_password", "google"]`, no
`registration_mode`, `existing_user_registration_behavior: "inline_sign_in"`):

1. The product opens `GET /auth`. The window always starts on the **sign-in** screen; there is no
   query parameter that opens registration. A new person has to choose **Create account** (or
   Google).
2. Enter an email on the create-account form. UOA replies "We sent instructions to your email".
3. Open the email and follow the link **within 30 minutes** (`EMAIL_TOKEN_TTL_MS`). An expired,
   used or unknown link silently shows the sign-in screen again.
4. **Set a password** (at least 8 characters) on the screen the link opens. This creates the account.
5. UOA redirects back to the product with an authorization code; the product backend exchanges it.

So registration is not only confirming the email: it also needs the create-account choice, a link
used within 30 minutes, and a new password. Each of those is a separate step above.

### Browser-bound verification (2026-10-22)

The hosted form now uses `/auth/registration/start`; it records the same
`register_submitted` and `registration_email` counters. Its link and code last 15
minutes. `/auth/registration/link` records `email_link_opened` only after the
explicit confirmation POST succeeds, outside the verification transaction; a GET,
scanner prefetch or status/WebSocket subscription never counts as mailbox proof.
Code verification is an alternative to opening the link and does not increment
the link counter. Both methods still reach the existing `set_password`,
`sign_in_completed` and `code_exchange` writers. A cross-device confirmation alone
neither authenticates the original flow nor counts a completed sign-in.

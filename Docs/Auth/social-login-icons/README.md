# Social sign-in layout verification

The shared `SocialButtons` component appears above sign-in, registration and invitation-registration forms.
It displays square logo links up to 64px wide, three per row, with each row centered.
Links shrink together when theme padding leaves less room on a narrow screen.
Button colors, radius and keyboard focus styling use the authenticator theme.
Translated names remain available to screen readers and as hover tooltips.

Before screenshots use base revision `49425434153810ba82486e836dc7e979a77f4784`.
After screenshots use this change's implementation. Both sets use the public Nessie
theme, English, and matching 1280×1100 or 390×1100 viewports. The narrow spacious-theme
comparison uses a matching 320×900 viewport. The local browser
bootstrap varies only the enabled-provider count; it does not bypass server
authentication or claim to verify a completed provider login.

Only changed screens and relevant remainder-row states are captured: sign-in with
six providers, sign-in with a single-item or two-item final row, and registration
with six providers, including invitation registration. Registration and Back to
sign in were reached through their existing buttons; invitation registration uses
the invitation-link entry point with a test-only token and email.

Verified on Windows Maxis, headless Microsoft Edge through Playwright, 4 November 2026:

- Sign-in and registration with 0–6 providers at 320px, 390px and 1280px: 42 states.
  No horizontal overflow; enabled links retain state, PKCE and team-hint parameters.
- Each icon is square and above the form. Rows contain three icons where available;
  one-item and two-item remainder rows share the first row's horizontal center.
- Tab order reaches all six provider links before email. Focus is visible, names
  are accessible, labels are visually hidden, and tooltips name the provider.
- Invitation registration at desktop and phone widths keeps the invited email
  read-only, the inviter-provided name editable, and the invitation token on each
  provider link. Its icon rows appear above the form.
- All three theme densities keep three icons per row at 320px. The spacious
  theme reduces each icon button to about 53px, preserving square touch targets.
- Password show/hide, registration/back navigation, provider-link activation and
  browser Back continue to work. Local provider activation uses a test response;
  it does not authenticate a real account.
- Native public-client sign-in still offers only Google and preserves its OAuth
  parameters. Social-only sign-in has no empty email form or OR divider.
- Spanish accessible names/tooltips and a dark theme with a custom 16px button
  radius render correctly.
- Auth typecheck, all 176 existing tests, client build and SSR build pass. ESLint
  passes for every changed source file. Package-wide lint reports the pre-existing
  unused `innerWidth` declaration in `Auth/e2e/organization-sign-in-evidence.mjs`.

The workspace override pins `follow-redirects` to at least 1.16.2, the patch for
[GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p).
The high/critical dependency audit passes with this lockfile.

Screenshots are embedded side by side in the pull request. No browser evaluation
was added to CI, and no API source, database, provider credentials or native app changed.

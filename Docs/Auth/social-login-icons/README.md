# Social sign-in layout verification

The shared `SocialButtons` component appears above the sign-in and registration forms.
It displays 64px square logo links, at most three per row, with each row centered.
Button colors, radius and keyboard focus styling use the authenticator theme.
Translated names remain available to screen readers and as hover tooltips.

Before screenshots use base revision `49425434153810ba82486e836dc7e979a77f4784`.
After screenshots use this change's implementation. Both sets use the public Nessie
theme, English, and matching 1280×1100 or 390×1100 viewports. The local browser
bootstrap varies only the enabled-provider count; it does not bypass server
authentication or claim to verify a completed provider login.

Only changed screens and relevant remainder-row states are captured: sign-in with
six providers, sign-in with a single-item or two-item final row, and registration
with six providers. Registration and Back to sign in were reached through their
existing buttons.

Verified on Windows Maxis, headless Microsoft Edge through Playwright, 4 November 2026:

- Sign-in and registration with 0–6 providers at 320px, 390px and 1280px: 42 states.
  No horizontal overflow; enabled links retain state, PKCE and team-hint parameters.
- Each icon is square and above the form. Rows contain three icons where available;
  one-item and two-item remainder rows share the first row's horizontal center.
- Tab order reaches all six provider links before email. Focus is visible, names
  are accessible, labels are visually hidden, and tooltips name the provider.
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

Screenshots are embedded side by side in the pull request. No browser evaluation
was added to CI, and no API, database, provider credentials or native app changed.

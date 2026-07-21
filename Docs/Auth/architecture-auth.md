# Auth Window Architecture

This document defines the internal architecture for the `/Auth` directory — the React-based auth UI rendered in the OAuth popup.

For the full product spec, see [brief.md](./brief.md). For tech stack, see [techstack.md](./techstack.md).

---

## Guiding Principles

- **No code file longer than 500 lines.** If a file approaches this limit, split it.
- **Keep the codebase reusable and clean.** This is the hard rule. If a component is reusable, it gets its own file. Small helper components that only serve a single parent can live in the same file if it makes sense.
- **Components are small and focused.** A component does one thing. If it does two things, consider splitting it.
- **All styling via Tailwind.** No CSS modules, no styled-components, no inline style objects. Tailwind classes only.
- **All theming from config.** No hardcoded colors, radii, fonts, or brand-specific styles anywhere in code.
- **Flat over nested.** Prefer shallow directory structures.

---

## Directory Structure

```
/Auth
  /src
    /components
      /ui
        Button.tsx            — Base button, styled from theme config
        Card.tsx              — Card container, styled from theme config
        Input.tsx             — Text input with label and error state
        PasswordInput.tsx     — Password input with show/hide toggle and strength indicator
        Logo.tsx              — Renders logo from config (image URL or styled text)
        Spinner.tsx           — Loading indicator
        Alert.tsx             — Generic error/success message display
        Divider.tsx           — Visual separator (e.g. "or continue with")
        CodeInput.tsx         — Reusable 6-digit numeric code input (Phase 3c; extracted from
                                 TwoFactorInput so email-code entry and 2FA share one implementation)
      /form
        LoginForm.tsx         — Email + password login form
        RegisterForm.tsx      — Email submission for registration
        PasswordSetForm.tsx   — Set new password (after verification)
        ResetPasswordForm.tsx — Password reset form
        TwoFactorInput.tsx    — 6-digit TOTP code input (wraps ui/CodeInput.tsx)
      /social
        SocialLoginButtons.tsx — Renders enabled social provider buttons from config
        SocialButton.tsx       — Individual social provider button
      /layout
        AuthLayout.tsx        — Main layout wrapper (card, logo, theme)
        LanguageSelector.tsx  — Language dropdown (shown only if multiple languages in config)
        PopupContainer.tsx    — Popup window wrapper and redirect handling
      /twofactor
        QrCodeDisplay.tsx     — QR code rendering for 2FA setup
        TwoFactorSetup.tsx    — Full 2FA enrollment flow (QR + verify)
      /workspace
        WorkspaceList.tsx        — Vertical stack of WorkspaceCards, server order preserved (Phase 3c)
        WorkspaceCard.tsx        — One ACTIVE workspace: icon + name + role (owner/admin only) (Phase 3c)
        InviteCard.tsx           — Pending team invite: accept / decline (Phase 3c)
        CreateWorkspaceCard.tsx  — "Create a new workspace" entry, shown when can_create_org (Phase 3c)
    /pages
      LoginPage.tsx           — Login page (email/password + social buttons)
      RegisterPage.tsx        — Registration page
      VerifyEmailPage.tsx     — Email verification landing
      ResetPasswordPage.tsx   — Password reset page
      SetPasswordPage.tsx     — Set password after verification
      TwoFactorSetupPage.tsx  — 2FA enrollment page
      TwoFactorVerifyPage.tsx — 2FA challenge during login
      CodeEntryPage.tsx       — Email sign-in code entry, login_flow.email_code_enabled (Phase 3c)
      WorkspaceChooserPage.tsx — Slack-style "choose a workspace" screen, workspace_selection: "auto" (Phase 3c)
      SigningPage.tsx         — Ordered PDF review, explicit click-wrap/typed-name signing, receipts, final recheck
      ErrorPage.tsx           — Generic error display
    /theme
      ThemeProvider.tsx       — React context provider, reads config and exposes theme values
      theme-utils.ts          — Maps config theme properties to Tailwind classes
      theme-defaults.ts       — Theme constants (CSS var names)
    /i18n
      I18nProvider.tsx        — React context provider for translations
      use-translation.ts      — Hook: returns `t()` function for current language
      language-loader.ts      — Loads translation files, triggers AI fallback for missing keys
      languages.ts            — Supported language definitions
    /hooks
      use-auth.ts             — Auth state management (current step, loading, errors)
      use-config.ts           — Reads and exposes parsed config from server
      use-theme.ts            — Shorthand hook for theme context
      use-popup.ts            — Popup lifecycle (redirect handling, window messaging)
    /utils
      api.ts                  — API client for calling auth server endpoints (includes the
                                 Phase 3c authStart/verifyLoginCode/selectTeam flow helpers)
      signature-api.ts        — Typed capability-session JSON/PDF calls for the hosted signing flow
      validation.ts           — Client-side input validation (email format, password rules)
      errors.ts               — Error display helpers (always generic)
      code-input.ts           — Pure numeric-code sanitization behind ui/CodeInput.tsx (Phase 3c)
      workspace-response.ts   — Decodes /auth/verify-code, /auth/select-team, and a
                                 chooser-producing /auth/login into one client outcome (Phase 3c)
      workspace-actions.ts    — Typed wrappers over the flow API calls used by the chooser (Phase 3c)
      workspace-icon.ts       — Deterministic initials-on-color fallback avatar (design §11.3, Phase 3c)
  /public
    index.html                — Entry point HTML
  vite.config.ts              — Build configuration
  tailwind.config.ts          — Tailwind configuration
  tsconfig.json               — TypeScript configuration
```

---

## Component Architecture

```
PopupContainer
  └── ThemeProvider (config-driven)
        └── I18nProvider (language-driven)
              └── AuthLayout (card + logo + language selector)
                    └── [Page Component]
                          └── [Form / UI Components]
```

### Pages

- Each page represents one screen in the auth flow
- Pages compose form components and UI components
- Pages use hooks for state, config, and translations
- Pages handle navigation between auth steps
- One page per file, no exceptions

### Components

- **`/ui`** — Primitive building blocks. Button, Card, Input, etc. Styled entirely from theme config via Tailwind classes.
- **`/form`** — Auth-specific form components. Each form handles its own input state and validation. Forms call the API client, they don't manage auth flow.
- **`/social`** — Social login button rendering. Reads social provider names from `enabled_auth_methods` to decide what to show.
- **`/layout`** — Structural wrappers. AuthLayout applies the theme card, logo, and language selector. PopupContainer manages the popup lifecycle, including forced 2FA setup and 2FA verification branches.
- **`/twofactor`** — 2FA-specific components. QR code display, setup/enrollment flow, and login verification.

### Rules

- Reusable components get their own file — always
- Small helper components that only serve one parent can live in the same file
- No component file exceeds 500 lines
- If a component grows complex, extract sub-components into separate files
- Components receive theme values through context (ThemeProvider), never from props drilling raw config

---

## Theming

- `ThemeProvider` wraps the entire app
- It reads the `ui_theme` property from the config JWT
- It maps config values (colors, radii, typography, logo, density) to Tailwind utility classes
- All components consume theme via the `use-theme` hook
- **No hardcoded brand styles anywhere** — every visual property comes from config
- `ui_theme` must be fully specified; missing theme properties should fail config validation

---

## i18n

- `I18nProvider` wraps the entire app
- It loads the translation file for the selected language
- Components use the `use-translation` hook which returns a `t("key")` function
- If a translation key is missing, the AI fallback is triggered via `language-loader.ts`
- AI-generated translations are cached server-side permanently
- Language selector dropdown is only rendered if config provides multiple languages
- Default language comes from the client website's selection (passed in config as optional `language`)

---

## Auth Flow Navigation

The auth flow is state-driven, not route-driven. A single popup URL loads the app, and the current auth step determines which page renders:

1. **Entry** → Config loaded → LoginPage (or RegisterPage based on config)
2. **Login** → Success → TwoFactorVerifyPage (if 2FA enabled) → Redirect with code
3. **Login** → Success → Redirect with code (if no 2FA)
4. **Register** → Email submitted → "Check your email" message
5. **Email verification** → VerifyEmailPage → SetPasswordPage → Redirect with code
6. **Password reset** → ResetPasswordPage → "Check your email" → SetPasswordPage
7. **2FA setup** → TwoFactorSetupPage → QR scan → Verify code → Done
8. **Error** → ErrorPage (generic message only)
9. **Email sign-in code** (Phase 3c, `login_flow.email_code_enabled`) → LoginPage "Email me a
   sign-in code" → CodeEntryPage → verify-code → WorkspaceChooserPage (if `workspace_selection:
"auto"`) or straight to step 2/3
10. **Workspace chooser** (Phase 3c, `workspace_selection: "auto"`) — reached after any verified
    identity path (email code/link, password, or social) → WorkspaceChooserPage (workspace list +
    pending invites + create-workspace). It is auto-skipped only for exactly one ACTIVE team and no
    pending invite; zero teams with `can_create_org` stays on the chooser. An invite-bound email is
    already an exact workspace selection and bypasses the chooser. Both server-selected and
    invite-selected org/team scope then passes through TwoFactorVerifyPage or required
    TwoFactorSetupPage and into the team-scoped authorization code. The chooser capability signs
    the exact config URL and parsed-config fingerprint plus redirect, PKCE, remember-me, and access
    request state. Final selection claims its hashed JTI as the transaction's first write, before
    invite/audit/access-request-email effects; a concurrent replay stops at that unique claim, while
    any later failure rolls the claim and all database effects back so the user may retry. Chooser
    hydration and invite decline are non-consuming. Legacy clients list only ACTIVE teams belonging
    to their own config domain. A verified first-party product domain may list all of the user's
    exact ACTIVE organisation + team memberships only when UOA's control plane has (a) an active
    `ClientDomain`, and (b) current `CUSTOMER_LIFECYCLE` app keys whose exact HTTPS `actorIssuer`
    maps unambiguously to one active `BillingService`. Unknown, inactive, expired, revoked, or
    multi-service mappings retain legacy same-domain isolation. Pending invites always remain
    same-domain. This product expansion is server-owned and read only through `uoa_admin`; signed
    config or browser input cannot opt into it. A recognized product requires one exact ACTIVE
    organisation + team even if its signed config disables org display or omits
    `user_needs_team`; those client-controlled flags cannot remove billing attribution. Exact
    membership is rechecked at selection, after 2FA/signatures immediately before code issuance,
    and at exchange. Recognized-product scope is resolved before the first 2FA decision on password,
    social, email-code, and email-link flows even when `workspace_selection: off`; "off" suppresses
    the chooser, not the server-owned attribution boundary. The exact selected Organisation joins
    strongest-wins policy resolution across domains.
    The selection and code-exchange transactions lock the organisation membership row first and
    team membership rows second, the same order used by membership
    activation/deactivation/removal, so those transactions and lifecycle changes have one serial
    outcome rather than a time-of-check/time-of-use gap. Post-2FA/signature code issuance performs
    the immediate revalidation only; exchange is the final locked authority before token creation.
    Auth-code, refresh, and confidential token issuance hold one global shared product-policy
    advisory lock through commit. The supported ClientDomain, lifecycle app-key, integration
    acceptance, and BillingService mutators take its exclusive form before reading or writing
    policy. Token issuance also re-reads the exact authenticated ClientDomain id/domain/status
    under the shared lock, closing the pre-handler/disable gap. `firstLogin.memberships` uses the
    same product policy, so it cannot contradict the signed `active` claim. A scoped refresh
    revalidates the exact policy, org, and team and fails with the
    normal invalid-refresh response if any of them changed; it never drops scope and silently
    selects or creates a different product-domain workspace. Same-domain selections remain valid
    if an unrelated product binding is later revoked. Recognized products reject an unscoped
    authorization code at exchange; only legacy clients can retain the late unscoped path. An auto
    flow or recognized product may select only one exact eligible ACTIVE workspace. Multiple choices
    fail closed. Zero choices create a personal org/team only when the config explicitly enables
    `user_needs_team`; otherwise a recognized product fails closed. First placement is serialized
    by a per-user transaction advisory lock, so simultaneous first logins from different products
    create one workspace and the loser reuses it. Legacy same-domain `workspace_selection: off`
    clients keep historical unscoped sessions when placement is already satisfied (or a lifecycle
    tombstone deliberately prevents healing), and their existing unscoped refreshes remain valid.
    Authorization codes also persist whether interactive TOTP completed. Exchange re-resolves the
    current exact-workspace policy and user enrollment inside the token transaction; insufficient
    proof rejects generically, rolls code consumption back, and creates no refresh/access family.
    Refresh rotation never performs placement or workspace switching. Confidential subject and
    chained grants perform outbound/JWT verification before opening this transaction, then recheck
    ClientDomain, product policy, exact cross-product membership, delegation, and one-time use under
    the shared lock before signing. Recognized products may not omit `active` from a subject
    assertion, so Ledger/AI attribution cannot become unscoped.
    Existing-account `LOGIN_LINK` tokens resolve only their issue-time `userId`; deletion or identity
    mismatch fails closed and never falls through to registration.
11. **Required agreements** (optional per-domain service) — after identity, workspace selection,
    and required 2FA, the shared API gate redirects to `SigningPage` instead of issuing a code.
    The page renders the hash-verified source PDF, exact acceptance statement, click-wrap or
    typed-name assertion, and downloadable receipt in Admin display order. Final completion
    rechecks current policy before following the preserved OAuth redirect. The opaque capability
    is held in memory and removed from the address bar after hydration.

These two steps are held entirely in client state (`use-popup.tsx`'s `pendingEmail`/`loginToken`/
`workspaceChoices`) between the identity-verification call and the final redirect — see
`Docs/plans/2026-07-07-slack-style-login-and-membership.md` §11.2.

---

## File Size Rules

- **Maximum 500 lines per code file.** No exceptions.
- **One React component per file.** No exceptions where it makes sense to separate.
- If a component grows past 200 lines, consider extracting sub-components
- If a page grows past 300 lines, extract form sections into separate components
- Utility files should stay under 200 lines — split by concern if needed

---

## API Communication

- All API calls go through `/utils/api.ts`
- The API client handles base URL, headers, and error normalization
- API errors are always displayed generically — the API client never surfaces specific error messages to the UI
- Loading and error states managed by the `use-auth` hook

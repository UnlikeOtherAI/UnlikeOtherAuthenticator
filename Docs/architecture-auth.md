# Auth Window Architecture

This document defines the internal architecture for the `/Auth` directory — the React-based auth UI rendered in the OAuth popup.

For the full product spec, see [brief.md](./brief.md). For tech stack, see [techstack.md](./techstack.md).

---

## Guiding Principles

* **No code file longer than 500 lines.** If a file approaches this limit, split it.
* **Keep the codebase reusable and clean.** This is the hard rule. If a component is reusable, it gets its own file. Small helper components that only serve a single parent can live in the same file if it makes sense.
* **Components are small and focused.** A component does one thing. If it does two things, consider splitting it.
* **All styling via Tailwind.** No CSS modules, no styled-components, no inline style objects. Tailwind classes only.
* **All theming from config.** No hardcoded colors, radii, fonts, or brand-specific styles anywhere in code.
* **Flat over nested.** Prefer shallow directory structures.

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
        Logo.tsx              — Renders logo from config URL
        Spinner.tsx           — Loading indicator
        Alert.tsx             — Generic error/success message display
        Divider.tsx           — Visual separator (e.g. "or continue with")
      /form
        LoginForm.tsx         — Email + password login form
        RegisterForm.tsx      — Email submission for registration
        PasswordSetForm.tsx   — Set new password (after verification)
        ResetPasswordForm.tsx — Password reset form
        TwoFactorInput.tsx    — 6-digit TOTP code input
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
    /pages
      LoginPage.tsx           — Login page (email/password + social buttons)
      RegisterPage.tsx        — Registration page
      VerifyEmailPage.tsx     — Email verification landing
      ResetPasswordPage.tsx   — Password reset page
      SetPasswordPage.tsx     — Set password after verification
      TwoFactorSetupPage.tsx  — 2FA enrollment page
      TwoFactorVerifyPage.tsx — 2FA challenge during login
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
      api.ts                  — API client for calling auth server endpoints
      validation.ts           — Client-side input validation (email format, password rules)
      errors.ts               — Error display helpers (always generic)
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

* Each page represents one screen in the auth flow
* Pages compose form components and UI components
* Pages use hooks for state, config, and translations
* Pages handle navigation between auth steps
* One page per file, no exceptions

### Components

* **`/ui`** — Primitive building blocks. Button, Card, Input, etc. Styled entirely from theme config via Tailwind classes.
* **`/form`** — Auth-specific form components. Each form handles its own input state and validation. Forms call the API client, they don't manage auth flow.
* **`/social`** — Social login button rendering. Reads `allowed_social_providers` from config to decide what to show.
* **`/layout`** — Structural wrappers. AuthLayout applies the theme card, logo, and language selector. PopupContainer manages the popup lifecycle.
* **`/twofactor`** — 2FA-specific components. QR code display and setup flow.

### Rules

* Reusable components get their own file — always
* Small helper components that only serve one parent can live in the same file
* No component file exceeds 500 lines
* If a component grows complex, extract sub-components into separate files
* Components receive theme values through context (ThemeProvider), never from props drilling raw config

---

## Theming

* `ThemeProvider` wraps the entire app
* It reads the `ui_theme` property from the config JWT
* It maps config values (colors, radii, typography, logo, density) to Tailwind utility classes
* All components consume theme via the `use-theme` hook
* **No hardcoded brand styles anywhere** — every visual property comes from config
* `ui_theme` must be fully specified; missing theme properties should fail config validation

---

## i18n

* `I18nProvider` wraps the entire app
* It loads the translation file for the selected language
* Components use the `use-translation` hook which returns a `t("key")` function
* If a translation key is missing, the AI fallback is triggered via `language-loader.ts`
* AI-generated translations are cached server-side permanently
* Language selector dropdown is only rendered if config provides multiple languages
* Default language comes from the client website's selection (passed in config)

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

---

## File Size Rules

* **Maximum 500 lines per code file.** No exceptions.
* **One React component per file.** No exceptions where it makes sense to separate.
* If a component grows past 200 lines, consider extracting sub-components
* If a page grows past 300 lines, extract form sections into separate components
* Utility files should stay under 200 lines — split by concern if needed

---

## API Communication

* All API calls go through `/utils/api.ts`
* The API client handles base URL, headers, and error normalization
* API errors are always displayed generically — the API client never surfaces specific error messages to the UI
* Loading and error states managed by the `use-auth` hook

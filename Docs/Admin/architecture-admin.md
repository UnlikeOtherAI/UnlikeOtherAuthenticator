# Admin Panel Architecture

This document defines the architecture for the React admin panel in `/Admin`.

Read this together with:

- `Docs/Admin/README.md` for the template baseline
- `Docs/techstack.md` for the overall repository stack
- `Docs/Requirements/roles-and-acl.md` for system-admin and `/internal/admin/*` auth requirements

## 1. Purpose

The admin panel is the authenticated operational frontend for UOA operators.

It is not a marketing site and it is not the auth popup UI.

It must be implemented as a React CSR app that translates the existing HTML templates in `Docs/Admin/` into reusable components.

## 2. Visual Baseline

The canonical visual baseline already exists:

- `Docs/Admin/template-login.html`
- `Docs/Admin/template-folder.html`
- `Docs/Admin/template-admin.html`

Do not rebuild the interface from scratch.

The implementation task is to convert these templates into reusable layouts, pages, and UI primitives while preserving the established information architecture and visual language.

## 3. Architecture Overview

Use a separate frontend application in `/Admin`.

Required stack:

- React
- TypeScript
- Vite
- React Router
- Tailwind CSS
- TanStack Query
- native `fetch` wrapped in a shared API client layer
- react-hook-form
- Zod
- Vitest

State model:

- TanStack Query for server state
- local component state for local-only concerns
- focused React Context for small shared UI state such as shell state, selected org context, and user preferences
- do not introduce Zustand unless the Context-based approach becomes materially insufficient

## 4. Module Boundaries

Use this structure (matches the current tree under `Admin/src/`):

```text
/Admin
  /src
    main.tsx                 — Vite entry, mounts <App /> with providers
    index.css                — Tailwind entry
    vite-env.d.ts            — Vite ambient types
    /app
      App.tsx                — Router and route tree (see §4.1)
      AppProviders.tsx       — Query client, router, and shared providers
    /layouts
      AdminLayout.tsx        — Authenticated shell composing Sidebar + Topbar + outlet
      Sidebar.tsx            — Shell sidebar
      Topbar.tsx             — Shell topbar
      navigation.ts          — Sidebar/topbar navigation model
    /pages                   — Route-level page components (one per route, see §4.1)
    /components
      /dialogs               — Shared dialog primitives (ConfirmDialog, UserDetailsModal, …)
      /icons                 — Inline SVG icon components (see §8.1)
      /search                — Shell-level search primitives (GlobalSearch)
      /sections              — Reusable page sections (e.g. DomainSigningKeysSection)
      /ui                    — Reusable presentational primitives (Button, Modal, Table, …)
    /features
      /admin                 — Admin-domain feature views, hooks, and orchestration
      /auth                  — Admin auth/session feature (admin-session, guards, callback flow)
      /shell                 — Shell-scoped feature state (e.g. AdminUiProvider)
    /services                — API clients and transport mapping
    /schemas                 — Frontend validation schemas and UI-facing contracts
    /config                  — Runtime config, env parsing, request-client setup
    /utils                   — Small generic helpers
```

Rules:

- `pages` own route composition only
- `layouts` own shell composition only — no feature components belong in `/layouts`
- `components` hold reusable UI pieces, organised by kind: `components/dialogs` for shared dialog primitives, `components/icons` for product-action icons (inline SVG), `components/search` for shell-level search primitives, `components/sections` for reusable page sections that aren't feature-owned, and `components/ui` for generic presentational primitives
- `features` hold feature-specific views, hooks, and orchestration; current subtrees are `admin`, `auth`, and `shell`
- `services` own API clients and transport mapping
- `config` owns runtime config, env parsing, and request-client setup
- `schemas` own frontend validation schemas and UI-facing contracts
- `utils` stay small and generic

## 4.1 Route Map

The React Router tree defined in `Admin/src/app/App.tsx` is:

Public (no session):

- `/login` — admin sign-in screen (`LoginPage`), styled from `template-login.html`
- `/auth/callback` — admin OAuth callback (`AdminAuthCallbackPage`); exchanges the authorization code with `POST /internal/admin/token`

Authenticated shell (`AdminSessionGuard` → `AdminUiProvider` → `AdminLayout`):

- `/` — index route, renders `DashboardPage`
- `/dashboard` — dashboard/home inside the admin shell
- `/integrations` — integration requests (`IntegrationRequestsPage`)
- `/secrets` — shared secrets view (`SecretsPage`)
- `/domains` — domains listing (`DirectoryDomainsPage`)
- `/domains/:domainId` — domain detail, including the §11 Domain Email and signing-keys sections (`DomainDetailPage`)
- `/organisations` — organisation listing and search (`OrganisationsPage`)
- `/organisations/:orgId` — organisation detail (`OrganisationDetailPage`)
- `/organisations/:orgId/teams/:teamId` — team detail under an organisation (`TeamDetailPage`)
- `/teams` — team listing across organisations (`TeamsPage`)
- `/users` — user listing and search (`UsersPage`)
- `/users/:userId` — user detail (`UserDetailPage`)
- `/superusers` — admin-domain super-user management (`SuperUsersPage`)
- `/logs` — login logs and audit surfaces (`LogsPage`)
- `/connection-errors` — connection-error inspection (`ConnectionErrorsPage`)
- `/feature-flags` — feature-flag apps listing (`AppsFlagsPage`, exported as `FeatureFlagsPage`)
- `/feature-flags/:appId` — feature-flag detail for an app (`FeatureFlagDetailPage`)
- `/feature-flags/:appId/groups/:groupId` — audience-group detail under a feature flag (`FeatureAudienceGroupPage`)
- `/settings` — system-level settings (`SettingsPage`)

Catch-all:

- `*` — redirects to `/dashboard`

When a template demonstrates a section that does not yet have a route here, use this route map rather than inventing a new page tree. When a new route is added in `App.tsx`, this list must be updated in the same change.

## 5. Data and API Rules

- The admin app talks to the API over HTTP only
- Frontend code must not import Prisma, database models, or backend-only utilities
- API access must be centralized behind services/query hooks
- Components must not decode raw transport payloads ad hoc
- Shared API error handling should map backend responses into a consistent UI-facing shape

## 6. Forms

- Use `react-hook-form` for non-trivial forms
- Use Zod schemas at the boundary
- Keep validation and normalization outside presentational components where possible
- Do not hand-roll inconsistent form state patterns per page

## 7. Auth Boundary

Production contract:

- Admin identity is first-party UOA identity.
- In production, the API service serves the Admin app from `/admin` on the same origin as the auth API.
- `/admin/login` starts the normal UOA auth flow with PKCE and the signed config served from `/internal/admin/config`.
- The first-party admin config must disable registration and allow only Google (`enabled_auth_methods: ["google"]`, `allow_registration: false`).
- `/admin/auth/callback` exchanges the returned authorization code with `POST /internal/admin/token`.
- Admin access tokens are issued by `POST /internal/admin/token` when the verified config domain is `ADMIN_AUTH_DOMAIN`.
- The admin token exchange accepts an authorization code and PKCE verifier, does not require browser code to know the domain-hash shared secret, and never returns refresh tokens.
- Admin access-token claims must not expose the domain-hash client identifier because browser code can decode JWT payloads.
- Admin access tokens are signed with `ADMIN_ACCESS_TOKEN_SECRET`, an auth-service-only secret that is not shared with client backends.
- A user can access the admin only when their admin access token has `role: "superuser"` for the configured UOA admin domain.
- When the database is enabled, the API also verifies the token subject has a `SUPERUSER` `domain_roles` row for the admin domain.
- `/internal/admin/*` is the backend admin route family.
- `/internal/admin/*` accepts `Authorization: Bearer <access_token>` and validates it server-side.
- `ADMIN_AUTH_DOMAIN` is the domain allowed for admin superuser tokens; it defaults to the resolved auth service identifier, usually the `PUBLIC_BASE_URL` host.
- browser code must not use the domain-hash shared-secret mechanism directly

Frontend session interface:

- `Admin/src/features/auth/admin-session.ts` stores only the short-lived admin access token in `sessionStorage`.
- on load, call `/internal/admin/session` with `Authorization: Bearer <access_token>` before rendering protected pages
- any missing, expired, invalid, non-admin-domain, or non-superuser token must clear the session and kick the user back to `/admin/login`
- expose `useAdminSession(): { adminUser: { email: string } | null; isLoading: boolean; isAuthenticated: boolean }`
- expose an `AdminSessionGuard` component that blocks protected routes when `isAuthenticated` is false
- a development-only bypass may exist only behind `VITE_ADMIN_BYPASS_AUTH=true` and must not affect production builds

## 8. Reuse Rules

- If the same pattern appears more than once, extract it
- Do not duplicate shell markup across pages
- Prefer reusable table, filter, badge, dialog, and form primitives
- Keep feature-specific composition in `features`, not global primitives

## 8.1 Icons and UI States

- use one icon approach consistently for admin product-action icons: inline SVG components checked into the repo
- reserve `/assets` for UOA-owned branding assets such as app icons, favicons, and brand marks
- use consistent loading states: skeletons for tables/cards, inline spinners for short actions, and page-level empty/error states for failed queries
- keep query error presentation centralized rather than inventing per-page ad hoc patterns

## 9. Quality Gate

- ESLint must cover all `/Admin` source files
- TypeScript strictness must remain enabled
- Lint failures must fail the build
- Vitest must cover reusable logic and component behavior as the app grows
- Avoid `any`, dead code, and unused exports
- Keep components small and composable

## 10. Environment

The admin app must read configuration from Vite environment variables.

Current required frontend variables:

- `VITE_API_BASE_URL`
- `VITE_ADMIN_BYPASS_AUTH` for development-only auth bypass

Do not hardcode hosts or protocols in components.

## 11. Domain Email

Domain detail pages include a transactional email section. The section reads and writes `/internal/admin/domains/:domain/email`, registers SES sender identities, displays DNS records, refreshes verification/DKIM status, and only enables sending after both statuses are `Success`.

Super-users are managed from `/superusers`. This page lists current `ADMIN_AUTH_DOMAIN` super-users, searches eligible UOA users, grants access, and protects revocation with a confirmation dialog.

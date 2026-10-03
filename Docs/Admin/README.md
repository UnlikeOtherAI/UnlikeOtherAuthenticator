# Admin Panel Templates and Build Rules

This directory already contains the canonical visual templates for the admin panel.

Do not redesign these screens from scratch when implementing the React admin app.

The implementation job is to translate these templates into reusable React components and page layouts while preserving the existing visual direction and interaction model.

`Docs/Admin/architecture-admin.md` is the canonical source for the admin panel architecture, auth boundary, and quality gate.

This file is the canonical source for the template baseline only.

## Existing Templates

- `template-login.html` — admin sign-in screen
- `template-folder.html` — sidebar and top-bar shell/layout template
- `template-admin.html` — richer admin content examples and interaction patterns

These files are the starting point for the admin panel UI.

The React implementation must treat them as reference templates for:

- page layout
- navigation structure
- spacing rhythm
- card/table/filter/search patterns
- icon usage
- visual hierarchy

## Build Direction

- Build the admin panel in `/Admin` as its own frontend app
- Implement it as a React CSR app, not SSR
- Follow the stack rules in `Docs/techstack.md`
- Follow the architecture rules in `Docs/Admin/architecture-admin.md`

## Template Translation Rules

- Do not recreate the admin UI from memory or from generic dashboard patterns
- Start from these templates and map them into components deliberately
- Preserve the existing information architecture unless the docs explicitly change it
- Reuse the provided icons and assets from `/assets`
- If a template shows a layout shell, convert that shell into reusable layout components rather than copying markup into every page

## Linting and Quality Rules

The admin panel must be under strict linting from the start.

Non-negotiable rules:

- ESLint must run on all `/Admin` source files
- TypeScript strictness must be enabled
- Builds must not pass when lint fails
- Prefer zero warnings; warning-only quality gates should not be relied on
- Components must stay small, focused, and reusable
- No dead code, unused exports, or loose `any` usage without explicit justification

## Implementation Reminder for LLMs and Agents

If you are building the admin panel:

1. Read these template files first.
2. Read `Docs/techstack.md` and `Docs/Admin/architecture-admin.md` before choosing architecture or libraries.
3. Do not invent a new dashboard design.
4. Reuse the template structure and visual language.
5. Keep the codebase under strict lint and typecheck gates.

## 2026-10-03 approved UI refactor amendment

The operator explicitly approved decluttering the entire admin panel, revising its menu and
record navigation, and removing unjustified or nonfunctional interface elements while
preserving working operations. For this approved work, the current route/menu contract in the
[architecture amendment](architecture-admin.md#2026-10-03-approved-navigation-and-interaction-amendment)
and [capability audit](admin-ui-refactor-audit.md) supersedes the earlier requirement to preserve
the template information architecture exactly. The original templates and rules above remain
as historical design references; this amendment does not delete or rewrite them.

Continue using the existing React/Tailwind visual language, icons and reusable primitives.
Each retained control must either navigate to a real record, disclose useful information or
perform a supported operation. Do not restore placeholder saves, fake confirmations, invented
counts or implementation-only prose merely because a historical template contains them.
Authentication, identity authority, commercial invariants and the strict quality gate remain
unchanged by this visual/navigation authorization.

# CLAUDE.md — Project Instructions

This file is the source of truth for how to work with this repository. Any agent, LLM, or contributor working on this project **must** read and follow these instructions.

---

## Project Overview

This is a **centralized OAuth / authentication service** used by multiple products.

### Sources of Truth

These documents define **what** we're building and **how**:

- **[`Docs/brief.md`](./Docs/brief.md)** — The full build brief. Defines the product, features, security model, constraints, and task breakdown. This is the single source of truth for what we're building.
- **[`Docs/techstack.md`](./Docs/techstack.md)** — The tech stack and project structure. Defines technology choices (Node.js, React, Tailwind, PostgreSQL + Prisma), folder layout (`/API`, `/Auth`), and environment variables. This is the single source of truth for how it's built.
- **[`Docs/Auth/architecture-api.md`](./Docs/Auth/architecture-api.md)** — API architecture. Defines the layered structure (routes → middleware → services → Prisma), directory layout, error handling patterns, and file organization rules for `/API`.
- **[`Docs/Auth/architecture-auth.md`](./Docs/Auth/architecture-auth.md)** — Auth window architecture. Defines the React component structure, theming system, i18n approach, and auth flow navigation for `/Auth`.
- **[`Docs/Admin/architecture-admin.md`](./Docs/Admin/architecture-admin.md)** — Admin panel architecture. Defines the React CSR structure, auth boundary, quality gate, and component/data-layer rules for `/Admin`.
- **[`Docs/Admin/README.md`](./Docs/Admin/README.md)** — Admin template baseline. Identifies the existing HTML templates that the React admin app must translate rather than redesign.
- **[`Docs/Requirements/roles-and-acl.md`](./Docs/Requirements/roles-and-acl.md)** — Role and admin-auth requirements. Defines `system_admin`, `/internal/admin/*` auth boundaries, and org/team role semantics.
- **[`Docs/deploy.md`](./Docs/deploy.md)** — Deployment to Google Cloud Run (build, deploy, env vars, service config).
- **[`Docs/api-2.0-implementation-plan.md`](./Docs/api-2.0-implementation-plan.md)** — Branch-specific implementation plan for `api-2.0`. Read this as the execution guide when working on that branch.

Before making any architectural, design, or implementation decisions, read all documents above in full.

If you are working on branch `api-2.0`, read [`Docs/api-2.0-implementation-plan.md`](./Docs/api-2.0-implementation-plan.md) before implementation work.

---

## Key Rules

### Never Remove, Always Add

- Do **not** remove or rewrite content from `Docs/brief.md` unless explicitly instructed
- Clarifications and additions are welcome; deletions are not
- If something in the brief seems wrong, flag it — don't silently change it

### Brief Is Law

- All implementation decisions must align with `Docs/brief.md`
- If the brief doesn't cover something, ask before assuming
- If you spot a contradiction, raise it rather than picking a side

### Code Style & Approach

- **No code file longer than 500 lines.** Documentation is exempt, but all `.ts`, `.tsx`, `.js`, `.jsx` files must stay under 500 lines. Split if approaching the limit.
- **Keep the codebase reusable and clean.** This is the hard rule. Prefer one React component per file, but small helper components that only exist to support a parent can live in the same file if it makes sense. If a component is reusable, it gets its own file.
- Keep it simple — no over-engineering
- No premature abstractions
- No features beyond what the brief specifies
- Tailwind-only for UI — no other CSS frameworks
- Stateless where possible
- Follow the architecture docs: [`architecture-api.md`](./Docs/Auth/architecture-api.md) for API, [`architecture-auth.md`](./Docs/Auth/architecture-auth.md) for the auth window, [`architecture-admin.md`](./Docs/Admin/architecture-admin.md) for the admin panel

### Security

- Shared secret never in code, only in environment variables
- No email enumeration — ever
- All auth errors are generic to the user
- Only provider-verified emails accepted from social logins
- All config JWTs must be verified before trust

### API Schema & /llm Endpoint

- `GET /` must always return the full endpoint schema for all routes (method, path, description, auth, query, body, response)
- `GET /llm` must always return comprehensive configuration documentation (config JWT fields, env vars, integration guide)
- When adding, removing, or changing any endpoint, update both `API/src/routes/root/index.ts` and `API/src/routes/root/llm.ts`
- These endpoints are the machine-readable contract for the API — they must never fall out of sync

### What Not To Build

These are explicitly out of scope unless noted otherwise (see brief section 20):

- Admin dashboard is now in scope; see `Docs/Admin/`
- No local avatar storage
- No per-client OAuth secrets
- No user-visible error specificity
- No unsigned configs accepted
- Refresh tokens are now implemented; see `Docs/Auth/long-lived-tokens.md`
- No backup codes for 2FA

---

## Repository Structure

```
CLAUDE.md                   — This file (project instructions)
AGENTS.md                   — Agent onboarding instructions
Docs/
  brief.md                  — Full build brief (the spec)
  techstack.md              — Tech stack and project structure
  Auth/
    architecture-api.md     — API architecture (/API)
    architecture-auth.md    — Auth window architecture (/Auth)
  Admin/
    architecture-admin.md   — Admin panel architecture (/Admin)
    README.md               — Admin template baseline
  Requirements/
    roles-and-acl.md        — Roles, ACL, and system-admin auth requirements
API/                        — Node.js auth server (see Docs/Auth/architecture-api.md)
Auth/                       — React auth UI (see Docs/Auth/architecture-auth.md)
Admin/                      — Admin panel UI
```

---

## Working With This Repo

1. Read `Docs/brief.md` before doing anything
2. Read this file (`CLAUDE.md`) for working rules
3. On branch `api-2.0`, read `Docs/api-2.0-implementation-plan.md` before implementation work
4. When in doubt, ask — don't assume
5. Commit messages should be clear and describe the "why"
6. Don't create files unless necessary — prefer editing existing ones

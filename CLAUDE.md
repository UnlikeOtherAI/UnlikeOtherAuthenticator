# CLAUDE.md — Project Instructions

This file is the source of truth for how to work with this repository. Any agent, LLM, or contributor working on this project **must** read and follow these instructions.

---

## Project Overview

This is a **centralized OAuth / authentication service** used by multiple products.

### Sources of Truth

These two documents define **what** we're building and **how**:

- **[`Docs/brief.md`](./Docs/brief.md)** — The full build brief. Defines the product, features, security model, constraints, and task breakdown. This is the single source of truth for what we're building.
- **[`Docs/techstack.md`](./Docs/techstack.md)** — The tech stack and project structure. Defines technology choices (Node.js, React, Tailwind, PostgreSQL + Prisma), folder layout (`/API`, `/Auth`), and environment variables. This is the single source of truth for how it's built.
- **[`Docs/architecture-api.md`](./Docs/architecture-api.md)** — API architecture. Defines the layered structure (routes → middleware → services → Prisma), directory layout, error handling patterns, and file organization rules for `/API`.
- **[`Docs/architecture-auth.md`](./Docs/architecture-auth.md)** — Auth window architecture. Defines the React component structure, theming system, i18n approach, and auth flow navigation for `/Auth`.

Before making any architectural, design, or implementation decisions, read all documents above in full.

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

### Hands Off Steroids

- Do **not** read, write, modify, or delete `.steroids/steroids.db` unless explicitly asked by the user
- Steroids manages its own database — treat it as an external system
- Use the `steroids` CLI to interact with tasks, sections, and project state — never touch the DB directly
- **Do NOT write or edit code when steroids tasks exist.** Steroids spawns its own coder/reviewer LLM agents to implement tasks. Your role is to create sections, add tasks, manage dependencies, and start/stop runners — not to write implementation code. If you edit code, steroids will revert it or conflict with its own changes.
- **Starting the runner:** Use `steroids runners start --detach` (background daemon) or `steroids loop` (foreground). Do NOT use `steroids run`, `steroids start`, or other invented commands.
- **Always run `steroids llm` first** before using any steroids commands. This prints the full CLI reference and ensures you use the correct syntax. Do this at the start of every session that involves steroids.
- **Key CLI commands:** `steroids tasks add`, `steroids sections add`, `steroids sections depends-on`, `steroids runners start --detach`, `steroids runners list`, `steroids runners status`, `steroids tasks stats`.

### Code Style & Approach

- **No code file longer than 500 lines.** Documentation is exempt, but all `.ts`, `.tsx`, `.js`, `.jsx` files must stay under 500 lines. Split if approaching the limit.
- **Keep the codebase reusable and clean.** This is the hard rule. Prefer one React component per file, but small helper components that only exist to support a parent can live in the same file if it makes sense. If a component is reusable, it gets its own file.
- Keep it simple — no over-engineering
- No premature abstractions
- No features beyond what the brief specifies
- Tailwind-only for UI — no other CSS frameworks
- Stateless where possible
- Follow the architecture docs: [`architecture-api.md`](./Docs/architecture-api.md) for API, [`architecture-auth.md`](./Docs/architecture-auth.md) for the auth window

### Security

- Shared secret never in code, only in environment variables
- No email enumeration — ever
- All auth errors are generic to the user
- Only provider-verified emails accepted from social logins
- All config JWTs must be verified before trust

### What Not To Build

These are explicitly out of scope (see brief section 20):

- No admin dashboard
- No local avatar storage
- No per-client OAuth secrets
- No user-visible error specificity
- No unsigned configs accepted
- No refresh tokens
- No backup codes for 2FA

---

## Repository Structure

```
CLAUDE.md                   — This file (project instructions)
AGENTS.md                   — Agent onboarding instructions
Docs/
  brief.md                  — Full build brief (the spec)
  techstack.md              — Tech stack and project structure
  architecture-api.md       — API architecture (/API)
  architecture-auth.md      — Auth window architecture (/Auth)
API/                        — Node.js auth server (see architecture-api.md)
Auth/                       — React auth UI (see architecture-auth.md)
```

---

## Working With This Repo

1. Read `Docs/brief.md` before doing anything
2. Read this file (`CLAUDE.md`) for working rules
3. When in doubt, ask — don't assume
4. Commit messages should be clear and describe the "why"
5. Don't create files unless necessary — prefer editing existing ones

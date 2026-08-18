# Security Backlog — carry-forward for next audit

Living list of known, deferred security items to (re)assess at the next security
audit. Unlike the dated point-in-time reviews (e.g. `security-review-2026-04-20.md`),
this file is updated as items are found and removed as they are fixed.

Severity: **Critical** (exploitable w/o auth or breaks core invariant), **High**
(exploitable with weak preconditions or breaks spec), **Medium** (hardening /
defense in depth), **Low** (nit / future-proofing), **Info** (good practice noted).

---

## Dependencies

### D1. `nodemailer <= 9.0.0` — `raw` option bypasses file/URL access guards — Medium (not currently reachable)
- **Found:** 2026-06-18 (CI `Dependency audit` job, `pnpm audit --audit-level high`).
- **Advisory:** GHSA-p6gq-j5cr-w38f (rated **high** by the advisory). Vulnerable `<= 9.0.0`, patched `>= 9.0.1`.
- **Location:** `API/package.json` declares `nodemailer: ^7.0.11`; sole usage in `API/src/services/email.providers.ts:99-123` (`createTransport` + `sendMail`).
- **Evidence:** The message-level `raw` option bypasses nodemailer's `disableFileAccess` / `disableUrlAccess` protections, enabling arbitrary local file read and full-response SSRF embedded into the delivered message. The current `sendMail` call only passes `from`, `to`, `replyTo`, `subject`, `text`, `html` — **no `raw`, no `attachments`, no file/URL content sources** — and all string fields come from server-side templates (`email.templates.ts`), not untrusted raw messages.
- **Impact (this codebase):** The exploit vector (`raw` → bypass → file read / SSRF) is **not reachable with current usage**. The audit flags the installed *version*, not a triggered code path. Effective risk today is low/theoretical; the concern is regression — a future change that adds `raw`/`attachments` would expose it.
- **Fix:** Bump `nodemailer` to `>= 9.0.1` (and `@types/nodemailer` accordingly). Note `^7 → 9` is a major jump; the `createTransport`/`sendMail` surface used here is trivial and stable across versions, but verify the lockfile, `pnpm audit`, and the email tests after the bump. Until then, do not introduce the `raw` or file/URL-based `attachments` options.
- **Status:** Deferred (decided 2026-06-18 — not acutely exploitable; revisit at next audit). Owner: TBD.

### D2. `deepmerge-ts <8.0.0` — stack exhaustion — patched by a temporary `pnpm.overrides` pin
- **Found:** 2026-08-17 (CI `Dependency audit` job, `pnpm audit --audit-level high`). No source change caused it — the advisory was published after the lockfile was written.
- **Advisory:** GHSA-ggr8-5vv4-36mx / CVE-2026-40345 (**high**). Vulnerable `<8.0.0`, patched `>=8.0.0`.
- **Location:** transitive only — `API > prisma (devDependency) > @prisma/config > deepmerge-ts`. `@prisma/config` pins the exact version and calls `deepmerge` once, as the `merger` c12 uses to combine `prisma.config.*` layers. It is not reachable from `@prisma/client` or from anything the server runs in production.
- **Fix applied:** `pnpm.overrides` entry `"deepmerge-ts@<8.0.0": "^8.0.1"` in the root `package.json`, resolving the tree to `8.0.1`. Upgrading Prisma cannot fix this yet: `@prisma/config@7.9.1` (latest stable as of 2026-08-18) still pins `deepmerge-ts 7.1.5`, and `prisma@8.0.0-rc.4` — which drops `@prisma/config` entirely — is a release candidate.
- **Compatibility:** v8's breaking changes are deep-merging of `Map` values, two type renames, and a `deepmergeInto` input-mutation fix. `@prisma/config` merges plain config records with `deepmerge` only, so none apply. Verified by `prisma generate` and by the integration suite, which runs `prisma migrate deploy` per test file.
- **Remove when:** a stable `prisma`/`@prisma/client` release resolves `deepmerge-ts >=8.0.0` on its own — check with `npm view @prisma/config@<version> dependencies`. Drop the override then, so the scoped pin does not silently outlive the advisory.
- **Status:** Fixed by override 2026-08-18; the override itself is the carry-forward item.

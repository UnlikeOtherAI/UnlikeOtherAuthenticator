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

---

## Deferred from the 2026-08-19 audit

Three findings from the 2026-08-19 multi-agent audit were verified as real but
deliberately not fixed in that pass. Each needs a decision that is not the
auditor's to make. See `Docs/Reviews/security-review-2026-08-19.md` for the full
audit, including the findings that were refuted.

### B1. Rate-limit state is per-process, so every budget divides by replica count — Medium
- **Found:** 2026-08-19. Previously raised as C1 in `security-review-2026-04-20.md`; the limiters
  were added, the shared store was not.
- **Location:** `API/src/middleware/rate-limiter.ts:28` — `const windows = new Map<string, WindowState>();`
  is module-level, and backs every limiter built by `createRateLimiter`.
- **Evidence:** No Redis or other shared store exists anywhere under `API/src`. UOA runs on Cloud Run
  (`Docs/deploy.md`), so N instances means N independent budgets, and any deploy or cold start resets
  all counters.
- **Impact:** Every per-IP and per-identifier limit is effectively multiplied by the instance count,
  and an attacker can reset a budget by triggering a scale event. The database-side caps that do NOT
  live in the limiter still hold — the per-code attempt cap in `login-code.service.ts` and the TOTP
  replay counter in `twofactor-login.service.ts` — so brute-force of a single credential remains
  bounded. What is unbounded is the aggregate.
- **Why deferred:** The fix is an infrastructure decision, not a code change: Redis (new dependency,
  new failure mode, new cost) versus a Postgres-backed window (no new dependency, a write per request
  on the hot path). Picking one without the deployment owner is guesswork.
- **Partial mitigation applied 2026-08-19:** every credential-guarding limiter and the public
  team-avatar route now compose their per-IP bucket with a global bucket that no request input can
  move (`API/src/routes/auth/rate-limit-keys.ts`, `API/src/routes/avatar/public-team.ts`). That bounds
  a header-rotating flood per instance; it does not make the budget global.

### B2. `BILLING_ACTOR_AUDIENCE_MODE` still defaults to `warn` — Medium
- **Found:** 2026-08-19.
- **Location:** `API/src/config/env.ts:250` — `z.enum(['warn', 'enforce']).default('warn')`;
  the permissive branch is `API/src/services/billing-actor-audience.service.ts:71-81`.
- **Evidence:** In `warn` mode a `X-UOA-Actor` assertion whose `aud` is the legacy constant is accepted
  on any of the 22 endpoints in `BILLING_ACTOR_ENDPOINTS`, rather than only the one it names. The
  signature is still verified first and the actor's authority is still re-resolved server-side, so this
  is replay across endpoints by a party that already holds a valid app key, not forgery.
- **Impact:** The per-endpoint binding that `Docs/Auth/billing-actor-assertions.md` specifies is not
  in force. Every use is logged, which is the point of the transition mode.
- **Why deferred:** Flipping the default to `enforce` is a coordinated release, not a code change.
  Per `Docs/deployment.md`, each consuming product must redeploy and serve a new config before it
  mints correctly-scoped assertions; flipping first breaks live billing calls for any product that
  has not. The procedure is already written down at `Docs/deploy.md:172`.
- **Next step:** Read the warn-mode logs to confirm no relying party still mints the legacy audience,
  then flip. Owner: whoever owns the product release train.

### B3. Three team-invitation routes silently ignore a forwarded user token — Low
- **Found:** 2026-08-19.
- **Location:** `API/src/routes/org/team-invitations.ts` — the list, get-one and resend routes carry
  `[requireDomainHashAuthForDomainQuery(), configVerifier, parseDomainContextHook, requireOrgFeatures]`
  with no `requireOrgRole()`. The DELETE route in the same file does include it.
- **Evidence:** `listTeamInvites` / `getTeamInvite` (`team-invite.service.management.ts`) take
  `{ orgId, teamId, domain }` and `resolveInviteTarget` (`team-invite.service.base.ts`) resolves org by
  id and team by `(id, orgId)` — no actor parameter anywhere. A partner BFF that attaches the domain
  hash and forwards `X-UOA-Access-Token` gets the same answer whether that token is scoped to this org,
  to a different org, or to no org at all.
- **Impact:** Intra-domain, cross-org read of invite metadata (invited email addresses) by a caller who
  already holds the domain-hash bearer. Bounded, but the codebase treats a silently-ignored forwarded
  token as an incident class everywhere else — see the `requireOrgBackendOnly` doc comment in
  `org-role-guard.ts`.
- **Why deferred:** Both fixes change a live API contract. Adding `requireOrgRole()` also adds the
  `backend_org_management` opt-in and an origin-domain 404, which would break any BFF working today.
  Adopting the `requireOrgBackendOnly` stance instead rejects a present `X-UOA-Access-Token`, which
  breaks BFFs that forward it harmlessly. Either way `API/src/routes/root/schema.org-invitations.ts`
  and `API/src/routes/root/llm-integration-teams.ts:21` must be updated to match.
- **Next step:** Decide which shape these three routes are meant to be — backend-only, or user-scoped
  like their DELETE sibling — then implement that one and re-sync `/api` and `/llm`.

### B4. The domain-hash bearer is still a token claim and a plaintext DB column — Medium, needs a design decision
- **Found:** 2026-08-19, by the review of the audit's own fixes — not by the audit.
- **The contradiction:** `API/src/middleware/domain-hash-auth.ts` declares of `domainAuthClientId`: *"It is full system trust for that domain (brief §24.10), so it must never be persisted, logged, put in an audit row, or returned in a response."* That declaration is the sole justification for the `/domain/debug` fix in this audit. It is not true of the rest of the tree.
- **Where it is persisted and returned:**
  - `API/src/routes/auth/token-exchange.ts` passes `request.domainAuthClientId` in as `clientId`.
  - `API/src/services/refresh-token.service.ts:205` writes it to `RefreshToken.clientId` — `API/prisma/schema.prisma:528` is a plain `String` column, so the credential sits in the database in cleartext.
  - `signAccessToken` (`API/src/services/token.service.ts`) puts it in the access token's `client_id` claim, so it travels wherever that token travels — commonly to the end user's browser.
- **Why this is probably not "by design":** the newer confidential OAuth profile explicitly refuses to do it.
  `API/src/services/oauth/access-token.service.ts:143-144` states: *"`azp` is the non-secret source domain. In particular this profile never copies the domain-hash bearer credential into `client_id` (or any other claim)."* The codebase has already reached the right answer once; the legacy HS256 user-access-token path is the outlier.
- **Mitigating:** the party receiving the access token from `/auth/token` already authenticated with the bearer, so echoing it back to *that* caller discloses nothing new. The exposure is duration and spread — a long-lived token carrying a credential that is only remediable by rotation, plus a cleartext column.
- **The decision to make:** either (a) the bearer legitimately doubles as the client identifier, in which case soften the `domain-hash-auth.ts` declaration so the stated invariant matches reality — and accept that `/domain/debug` was fixed against an invariant the codebase does not hold; or (b) it does not, in which case the legacy path should carry the non-secret domain (or the `ClientDomain` id) the way the confidential profile carries `azp`, and `RefreshToken.clientId` should store a digest. Option (b) changes an access-token claim that relying parties may read, so it needs the same coordinated-release treatment as B2.
- **Do not close this by editing the comment alone** without deciding which of the two is true.

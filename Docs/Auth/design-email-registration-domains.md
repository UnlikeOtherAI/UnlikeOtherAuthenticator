# Design: Email Providers, Self-Registration, and Domain-Restricted Registration

**Status:** Reviewed (Claude, Codex, Gemini) — all findings addressed (round 2)
**Date:** 2026-02-20

---

## 1. Problem Statement

The auth service needs production-grade email delivery for password reset, registration, and 2FA recovery flows. The current implementation supports only SMTP (via nodemailer) and a `disabled` stub. We need:

1. **AWS SES** as a first-class email provider.
2. **Google Cloud email** equivalent for GCP-hosted deployments.
3. **Self-registration controls** — the client config should declare whether registrations are allowed.
4. **Domain-restricted registration** — certain deployments should only allow users with specific email domains to register (e.g. `@company.com`).
5. **Domain-to-org/team mapping** — when domain restrictions are active, the client config can specify which organisation and/or team a user should be placed into based on their email domain.

### Registration Philosophy

Registration with email should work the same way as login: user enters their email, receives a link, clicks it, and they're in. No mandatory password step — the user can always set a password later via "forgot password." This keeps onboarding friction minimal.

---

## 2. Email Provider Expansion

### 2.1 Current Architecture

```
email.service.ts
├── createEmailProvider(env) → EmailProvider
│   ├── 'disabled' → logs only, does not send
│   └── 'smtp'     → nodemailer transport
├── dispatchEmail(message) → catches errors, logs safely
└── sendLoginLinkEmail / sendPasswordResetEmail / etc.
```

The provider abstraction is clean — adding new providers means implementing the `EmailProvider` interface (`{ name, send(message) }`).

### 2.2 New Provider: AWS SES (`ses`)

**Dependency:** `@aws-sdk/client-ses` (v3, tree-shakeable)

**Env vars:**
```bash
EMAIL_PROVIDER=ses
AWS_REGION=eu-west-1           # SES region (required for SES)
AWS_ACCESS_KEY_ID=...          # Optional: falls back to instance role / env chain
AWS_SECRET_ACCESS_KEY=...      # Optional: falls back to instance role / env chain
EMAIL_FROM=noreply@example.com # Required (must be SES-verified identity)
EMAIL_REPLY_TO=...             # Optional
```

**Implementation:**
- Create `SESClient` with region from env.
- Credential resolution uses the standard AWS SDK chain (env vars → instance metadata → ECS task role → etc.), so explicit keys are optional in cloud environments.
- Use `SendEmailCommand` with `Destination`, `Message.Subject`, `Message.Body.Text`, `Message.Body.Html`.
- Error handling: catch `SESServiceException`, log only `$metadata.httpStatusCode` and error `name` — never serialize the full error object (AWS SDK v3 errors can include request metadata containing email addresses).
- Use dynamic `import()` for `@aws-sdk/client-ses` so the dependency is only loaded when the SES provider is selected.

**Operational notes:**
- **SES sandbox mode:** New AWS accounts start in SES sandbox. In sandbox, SES only delivers to individually verified email addresses and still returns HTTP 200 (no SDK error) — emails are silently dropped. Teams must request SES production access before go-live.
- Add a startup log warning when `EMAIL_PROVIDER=ses` and `NODE_ENV=production` to remind operators to verify production access.

### 2.3 Google Cloud: No Native Email API

Google Cloud does not have a direct equivalent to AWS SES. The recommended approaches are:

| Option | How It Works | Tradeoff |
|--------|-------------|----------|
| **SMTP relay** (Google Workspace) | Use the existing `smtp` provider with `smtp-relay.gmail.com` | Requires Google Workspace; 10k/day limit |
| **SendGrid** (GCP Marketplace partner) | New provider `sendgrid` using `@sendgrid/mail` | Well-supported, GCP-integrated, free tier available |
| **Mailgun** | New provider `mailgun` using Mailgun's REST API | Similar to SendGrid, less GCP-native |

**Recommendation:** Add `sendgrid` as the GCP-friendly option. SendGrid is the official GCP recommendation, available on the GCP Marketplace, and has a straightforward HTTP API.

**Env vars:**
```bash
EMAIL_PROVIDER=sendgrid
SENDGRID_API_KEY=SG.xxx        # SendGrid API key (use a restricted key scoped to "Mail Send" only)
EMAIL_FROM=noreply@example.com # Required (must be SendGrid-verified sender)
EMAIL_REPLY_TO=...             # Optional
```

**Implementation:**
- Use `@sendgrid/mail` package via dynamic `import()`.
- Call `sgMail.send({ to, from, subject, text, html })`.
- Error handling: same pattern as SES — catch, log safely, never expose.

**Operational notes:**
- **Domain authentication (DKIM/SPF)** is required for production deliverability. Single-sender verification is only suitable for low-volume testing.
- Use a restricted API key scoped to "Mail Send" only — never a full-access key.
- Enable event webhooks for bounce tracking.

### 2.4 Bounce and Complaint Handling

**Out of scope for this design.** Neither the design nor the existing codebase handles asynchronous bounce/complaint notifications from SES or SendGrid. SES enforces a <5% bounce rate and will suspend accounts that exceed it. SendGrid has similar enforcement.

Operators must configure bounce handling independently:
- **SES:** SNS topic → CloudWatch alarm or Lambda handler.
- **SendGrid:** Event Webhooks → external monitoring.

This is an operational concern, not an application concern. If bounce handling is needed inside the auth service in the future, it would be a separate design.

### 2.5 Updated Provider Factory

```typescript
export type EmailProviderName = 'disabled' | 'smtp' | 'ses' | 'sendgrid';
```

The `EMAIL_PROVIDER` env var selects the active provider. Only one provider is active per deployment. The `dispatchEmail` wrapper remains unchanged — it catches all errors and keeps API responses stable.

The factory's `switch` statement must have explicit `case` entries for `ses` and `sendgrid`. The `default` case must throw (or log a loud warning) rather than silently falling back to `disabled`. Since the Zod `EnvSchema` validates the value at startup, this is defense-in-depth only.

**Test isolation:** The existing `cachedProvider` singleton persists across tests. Add a `resetEmailProviderCache()` function (test-only, following the same pattern as `cachedEnv` reset) to prevent test interference when `process.env` is mutated between suites.

### 2.6 Env Schema Changes

Add to `EnvSchema` in `config/env.ts`:

```typescript
// AWS SES
AWS_REGION: z.string().min(1).optional(),
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are read by the AWS SDK directly, not parsed here.

// SendGrid
SENDGRID_API_KEY: z.string().min(1).optional(),
```

Update `EMAIL_PROVIDER` enum:
```typescript
EMAIL_PROVIDER: z.enum(['disabled', 'smtp', 'ses', 'sendgrid']).optional(),
```

**Deploy order:** `env.ts` must be updated in the same PR as the provider implementations. If `EMAIL_PROVIDER=ses` is set before the code is deployed, Zod will reject the value at startup (hard failure, not silent).

---

## 3. Self-Registration Controls

### 3.1 Config Field: `allow_registration`

Add to the client config JWT:

```typescript
allow_registration: z.boolean().optional().default(true),
```

**Behavior:**
- `true` (default): both existing and new users can use the email flow. New users are created on first visit.
- `false`: only existing users can log in. If an unknown email is submitted, the response is the same generic message (no enumeration), but no account is created and no verification email is sent.

**Where enforced:** `auth-register.service.ts` — the service already differentiates between existing and new users. When `allow_registration` is `false`, the "new user" branch silently returns (still responds with the generic success message).

**No impact on `POST /auth/login`:** The email+password login endpoint does not create users. If a non-existent email is submitted, login fails generically regardless of `allow_registration`. No change needed.

### 3.2 Social Login Interaction

`allow_registration` controls **email-based** self-registration only. Social login registration behavior is unchanged — if a social provider returns a verified email that doesn't exist, the user is created regardless of this flag.

**To fully disable new account creation**, the operator must:
1. Set `allow_registration: false` (blocks email registration).
2. Remove social providers from `enabled_auth_methods` (blocks social registration).

This is a deliberate design choice. Social login is gated by `enabled_auth_methods`, not by `allow_registration`. The two controls are independent. Documenting this for operators is important to prevent confusion.

Similarly, `registration_mode` (`password_required` vs `passwordless`) has **no effect on social login**. Social login never requires a password regardless of this setting — the user authenticates via the social provider. `registration_mode` only affects the email registration flow (whether the verification link requires setting a password or not).

---

## 4. Domain-Restricted Registration

### 4.1 Config Field: `allowed_registration_domains`

Add to the client config JWT:

```typescript
allowed_registration_domains: z
  .array(z.string().trim().toLowerCase().min(1))
  .min(1)
  .optional(),
```

**Semantics:**
- If **absent (`undefined`)**: no domain restriction — any email can register (subject to `allow_registration`).
- If **present with values**: only emails whose domain part (after `@`) matches one of the listed domains can register.
- An **empty array `[]` is rejected** by the `.min(1)` constraint on the array. This prevents a misconfiguration trap where `[]` silently passes validation but blocks all registrations (no domain can match an empty list). If the operator wants no restriction, they should omit the field entirely.

Enforcement code uses `!domains?.length` to check whether restrictions are active (handles both `undefined` and the impossible `[]` case defensively).

**Examples:**
```json
{
  "allow_registration": true,
  "allowed_registration_domains": ["company.com", "subsidiary.co.uk"]
}
```

Only `user@company.com` or `user@subsidiary.co.uk` can register. `user@gmail.com` would receive the same generic response but no account is created.

### 4.2 Scope of Restriction

**Domain restrictions apply to new account creation only. Existing users are unaffected.**

If a deployment initially has no domain restriction and users register with `@gmail.com`, and then the config is updated to `allowed_registration_domains: ["company.com"]`:
- Existing `@gmail.com` users can still log in (they receive login links as before).
- New `@gmail.com` users cannot register (silent return, generic response).
- The restriction is forward-only. It does not retroactively block or delete existing accounts.

If operators need to also block existing out-of-domain users, they must deactivate those accounts through another mechanism (not provided by this system). This is documented, not a gap.

### 4.3 Enforcement Points

1. **`auth-register.service.ts`** — before creating a new user, extract the domain from the email, check against `allowed_registration_domains`. If not allowed, return silently (generic response). The email is already lowercased by the route's Zod schema (`z.string().trim().toLowerCase().email()`), and the config domains are lowercased by the config schema's `.toLowerCase()` transform. Domain comparison is therefore case-insensitive by construction.
2. **Social login callback** — when a social provider returns a verified email that would create a new user, apply the same domain check. See section 4.5 for details.
3. **Never reveal restriction** — the API always returns the same generic message. The restriction is invisible to the requester.

### 4.4 Domain Matching

- Exact match after lowercase normalization (both sides are already normalized — see 4.3).
- No wildcard support (e.g., `*.company.com` is not supported). If subdomains need to be allowed, list them explicitly.
- The domain is extracted from the email: `email.split('@')[1]`.

### 4.5 Social Login Domain Restriction

When a social provider (Google, GitHub, etc.) returns a verified email for a user that does not exist:

1. The `callback.ts` route already has access to the parsed config (`validateConfigFields(payload)`).
2. `loginWithSocialProfile` in `social-login.service.ts` performs the user lookup internally — `callback.ts` does not know whether the user is new or existing before calling the service.
3. If the domain is not in the allowed list and the user is new:
   - The service must not create the user.
   - The callback redirects back to the auth UI with the existing generic error redirect (the same `redirect_url` with `error=auth_failed`). The user sees a generic "Authentication failed" message — no indication that their domain was rejected.
4. If the user already exists (return visit), domain restriction does not apply — they log in normally.

**Implementation location:** Pass `allow_registration` and `allowed_registration_domains` from the config into `loginWithSocialProfile` as optional parameters. The service already receives the full config object (`params.config`), so the fields are accessible. The domain check is applied inside `loginWithSocialProfile` at the point where it determines the user does not exist and would create a new record. This avoids a TOCTOU race (where a separate `findUnique` in the route could see "no user" but a concurrent request creates one before `loginWithSocialProfile` runs). The service returns a result indicating whether auth succeeded or was blocked, and `callback.ts` handles the redirect accordingly.

This couples `loginWithSocialProfile` to the registration config fields, but this is acceptable — the service already receives the full config and the domain check is a single guard clause. The alternative (duplicating the user lookup in `callback.ts`) introduces a race condition and is worse.

---

## 5. Domain-to-Organisation/Team Mapping

### 5.1 Config Field: `registration_domain_mapping`

When org features are enabled, the client config can specify where users should be placed based on their email domain:

```typescript
registration_domain_mapping: z
  .array(
    z.object({
      email_domain: z.string().trim().toLowerCase().min(1),
      org_id: z.string().trim().min(1),
      team_id: z.string().trim().min(1).optional(),
    }),
  )
  .optional()
  .superRefine((entries, ctx) => {
    if (!entries) return;
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      if (seen.has(entries[i].email_domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate email_domain: ${entries[i].email_domain}`,
          path: [i, 'email_domain'],
        });
      }
      seen.add(entries[i].email_domain);
    }
  }),
```

**Key constraint:** `email_domain` values must be unique within the array. Duplicate entries are rejected at config parse time.

**`registration_domain_mapping` is independent of `allowed_registration_domains`.** A mapping can exist without domain restrictions, and vice versa. The mapping fires for any new user whose email domain matches, regardless of whether domain restrictions are active. If `allowed_registration_domains` is set and the mapping references a domain not in the allowed list, the mapping is unreachable (because the user would be blocked before reaching placement). At config parse time, log a warning if any mapping domain is not in the allowed list — this is a misconfiguration hint, not a hard error.

**Example config:**
```json
{
  "allow_registration": true,
  "allowed_registration_domains": ["acme.com", "acme.co.uk"],
  "org_features": { "enabled": true },
  "registration_domain_mapping": [
    { "email_domain": "acme.com", "org_id": "org-hq", "team_id": "team-engineering" },
    { "email_domain": "acme.co.uk", "org_id": "org-uk" }
  ]
}
```

**Semantics:**
- When a user registers with `user@acme.com`, they are automatically added to org `org-hq` as a `member` (validated against `org_roles` in the config), and placed in team `team-engineering`.
- When a user registers with `user@acme.co.uk`, they are added to org `org-uk` as a `member`, placed in the default team (the one with `isDefault: true`).
- If `team_id` is omitted, the user goes into the org's default team.
- If org features are disabled, this field is ignored.

### 5.2 Automatic Placement on Registration

When a new user is created (either via email verification or social login callback):

1. Look up the user's email domain in `registration_domain_mapping`.
2. If a match is found and org features are enabled:
   a. **Verify ownership chain:** confirm `Organisation.domain === config.domain` and, if `team_id` is specified, `Team.orgId === org.id`. If the ownership chain fails, skip placement and log an error. This prevents a misconfigured config JWT from placing users into orgs/teams on other domains.
   b. **Check existing membership:** query `OrgMember` where `userId = newUser.id` and `org.domain = domain`. If the user is already a member of any org on this domain (e.g., manually added by an admin), skip placement silently. The brief mandates one org per user per domain.
   c. Add user as `member` to the specified org (`OrgMember`).
   d. Add user to the specified team (or the default team if `team_id` is omitted) (`TeamMember`).
3. If no match is found, no org placement occurs (standard behavior).

**Transaction semantics:** User creation and org placement are **separate operations**. User creation is committed first. Org placement is attempted afterward in a single Prisma `$transaction` (wrapping the `OrgMember` and `TeamMember` creates together). If the transaction fails, the user is still created — log the error and continue. The user is either fully placed (org + team) or not placed at all. No half-placed state.

**Config timing:** Org placement is resolved at **token consumption time** using the config fetched at that moment (via `configVerifier` middleware, which re-fetches and re-verifies on every request). If the client updates their config between when the user requested registration and when they click the verification link, the new config applies. This is consistent with the project's "config verified on every request" model.

**Idempotency:** If the same verification token is consumed twice (race condition), the user creation uses `upsert` on `userKey` to handle the case where another request already created the user. Org placement checks existing membership before inserting (step 2b above), preventing duplicate `OrgMember` rows.

**Duplicate pending tokens:** Two concurrent `POST /auth/register` calls for the same new email will each independently create a `VerificationToken` row (the current code does not check for an existing pending token). This is harmless — both tokens are valid, the user may receive two emails, and whichever token is consumed first creates the user. The second token either creates a duplicate user (caught by `upsert` idempotency) or expires unused. This is an acceptable edge case — deduplicating pending tokens would add complexity (locking, short-lived uniqueness constraints) for negligible benefit. If duplicate emails become an operational concern (e.g., spam risk), a "pending token exists for this email within TTL" guard can be added to `auth-register.service.ts` as a future refinement.

### 5.3 Query Endpoint: `GET /auth/domain-mapping`

A config-verified endpoint that allows the client UI to look up what org/team a given email domain maps to. Useful for showing "You'll be joining the Engineering team" before the user submits the registration form.

**Route:** `GET /auth/domain-mapping`

**Query params:**
- `config_url` (required) — standard config verification
- `email_domain` (required) — the domain to look up (e.g., `acme.com`)

**Response (200):**
```json
{
  "mapped": true,
  "org_id": "org-hq",
  "org_name": "Acme HQ",
  "team_id": "team-engineering",
  "team_name": "Engineering"
}
```

Or when no mapping exists or the referenced org/team is stale:
```json
{
  "mapped": false
}
```

**Security considerations:**
- Requires config verification — only callers who know the `config_url` (which returns a valid signed JWT) can use this endpoint.
- **Information disclosure trade-off:** This endpoint reveals org and team names for mapped domains. The `config_url` is not a secret (it's hosted by the client), so a determined attacker who knows the URL could probe domains to discover org names. This is an acceptable trade-off for a client-facing feature — the org/team names are not sensitive secrets, and the endpoint is gated behind a valid config JWT signature.
- If an operator considers org/team names sensitive, they should not use `registration_domain_mapping` and instead handle placement logic on their backend. Alternatively, they can omit this endpoint and have the Auth UI read the mapping directly from the config JWT it already has (client-side display without a server round-trip).
- The endpoint verifies `Organisation.domain === config.domain` before returning names. If the config references an org belonging to a different domain, `{ "mapped": false }` is returned.
- **Rate limiting:** Apply a standard per-IP rate limit (consistent with other read endpoints) to prevent exhaustive domain probing. Without rate limiting, the acceptable trade-off described above becomes more exploitable — a determined attacker could enumerate the full mapping structure at high speed.

### 5.4 Alternative: Client-Side Mapping Display

Instead of (or in addition to) the server endpoint, the client UI can derive display text from the `registration_domain_mapping` field in the config JWT it already has. The JWT contains `org_id` and `team_id` — the client could either:
- Display the IDs directly (not user-friendly).
- Include human-readable `org_name` and `team_name` fields in the config JWT mapping entries themselves (adds JWT size but removes the need for the server endpoint entirely).

This alternative is noted here for implementers to evaluate. The server endpoint is more flexible but has the disclosure trade-off. Client-side display is simpler and avoids the issue.

### 5.5 Why Not Use the Email Itself?

The query endpoint accepts `email_domain`, not the full email address. This prevents:
- Email enumeration (no user lookup occurs).
- Privacy leakage (the server doesn't know the full email at this stage).
- The mapping is purely config-driven — it reads from the config JWT, resolves names from the database, and returns. No user table involved.

---

## 6. Registration Flow Changes

### 6.1 Current Flow

```
POST /auth/register { email }
  → existing user? → send login link
  → new user?      → send verify-email-set-password link
```

### 6.2 Updated Flow

Check order: `allow_registration` first, then domain restrictions.

```
POST /auth/register { email }
  1. Is user existing?
     → Yes → send login link (always, regardless of any restrictions)
     → No  → continue to step 2

  2. allow_registration === false?
     → Yes → silent return (generic response, no email sent)
     → No  → continue to step 3

  3. allowed_registration_domains set and email domain not in list?
     → Yes → silent return (generic response, no email sent)
     → No  → continue to step 4

  4. registration_mode?
     → 'password_required' → send VERIFY_EMAIL_SET_PASSWORD link (existing behavior)
     → 'passwordless'      → send VERIFY_EMAIL link (new behavior)

  5. On token consumption:
     → create account
     → place in org/team if mapping exists (see 5.2)
     → issue authorization code → redirect
```

### 6.3 Passwordless Registration Option

The existing `VERIFY_EMAIL_SET_PASSWORD` token type requires the user to set a password on landing. To support passwordless registration:

**New token type:** `VERIFY_EMAIL` (no password required)

**Schema migration required:** The `VerificationTokenType` enum in `schema.prisma` currently has four values (`LOGIN_LINK`, `VERIFY_EMAIL_SET_PASSWORD`, `PASSWORD_RESET`, `TWOFA_RESET`). Adding `VERIFY_EMAIL` requires a Prisma migration (`ALTER TYPE ... ADD VALUE`). PostgreSQL enum additions are non-transactional in older versions — this must be noted in migration docs.

**Token consumption path:**

The existing `POST /auth/verify-email` route requires a `password` field in the request body and guards on `type === 'VERIFY_EMAIL_SET_PASSWORD'`. The passwordless path cannot use this route as-is. Two options:

**Option A (recommended): Refactor `POST /auth/verify-email` to branch on token type.**
- Make `password` optional in the body schema.
- Fetch the token first, check its type.
- If `VERIFY_EMAIL_SET_PASSWORD`: require password, existing behavior.
- If `VERIFY_EMAIL`: skip password, create user with `passwordHash: null`, issue auth code.

**Option B: New route `POST /auth/verify-email-passwordless`.**
- Separate route, simpler code, but adds endpoint surface.

Option A is preferred to avoid proliferating endpoints. The route already has the token lookup — branching on type is natural.

**New email template required:** The existing `sendVerifyEmailSetPasswordEmail` template prompts the user to set a password. A new template `sendVerifyEmailTemplate` is needed with copy that says "Click to verify your email and sign in" — no password prompt.

**How the Auth UI distinguishes:** The landing route `/auth/email/link` already receives a `token` query param. On the server side, the token's type is looked up from the database. For `VERIFY_EMAIL`, the server completes authentication directly (no form rendered). For `VERIFY_EMAIL_SET_PASSWORD`, the server renders the set-password form. The URL remains neutral — no account state leakage.

**Behavior when `VERIFY_EMAIL` token is consumed:**
1. Create user record with `passwordHash: null` (via `upsert` on `userKey` for idempotency).
2. Place user in org/team per domain mapping (if applicable, see section 5.2).
3. Issue authorization code → redirect to client with code.
4. User is fully authenticated — no password set.

**Setting a password later:**
- User can use the "forgot password" flow at any time to set a password.
- Login with email via `POST /auth/register` always works (sends a magic link regardless of whether a password is set).
- `POST /auth/login` (email+password) fails generically for users with null `passwordHash` — the existing `verifyPassword` runs a timing-safe dummy comparison and returns `false`. Rate limiting on `POST /auth/login` (already in place) mitigates brute-force attempts against null-password users.

**Config field to control this:**

```typescript
registration_mode: z.enum(['password_required', 'passwordless']).optional().default('password_required'),
```

- `password_required` (default): existing behavior — user must set a password during registration.
- `passwordless`: user receives a simpler verification link; account is created with no password.

**Invalid combination:** `allow_registration: false` + `registration_mode: 'passwordless'` is nonsensical (passwordless mode only affects new user registration, which is disabled). The Zod schema should enforce this with a `.refine()`:

```typescript
.refine(
  (config) => !(config.allow_registration === false && config.registration_mode === 'passwordless'),
  { message: 'registration_mode "passwordless" requires allow_registration to be true' }
)
```

---

## 7. Summary of Config Schema Changes

New optional fields in the client config JWT:

```typescript
// Registration controls
allow_registration: z.boolean().optional().default(true),

// Registration mode
registration_mode: z.enum(['password_required', 'passwordless']).optional().default('password_required'),

// Domain restrictions (empty array rejected — omit field for "no restriction")
allowed_registration_domains: z
  .array(z.string().trim().toLowerCase().min(1))
  .min(1)
  .optional(),

// Domain-to-org/team mapping (email_domain values must be unique — see section 5.1 for full superRefine)
registration_domain_mapping: z
  .array(
    z.object({
      email_domain: z.string().trim().toLowerCase().min(1),
      org_id: z.string().trim().min(1),
      team_id: z.string().trim().min(1).optional(),
    }),
  )
  .optional()
  .superRefine(/* duplicate email_domain check — see section 5.1 for full implementation */),
```

**Cross-field validation (`.superRefine` on the top-level config schema):**
- Reject `allow_registration: false` + `registration_mode: 'passwordless'`.
- Warn (log, not error) if any `registration_domain_mapping` entry's `email_domain` is not in `allowed_registration_domains` when that list is set.
- Reject duplicate `email_domain` values within `registration_domain_mapping` (see section 5.1 for the full `superRefine` implementation).

**Config JWT size:** The config JWT is fetched via HTTP from `config_url`, not passed in a header or cookie. JWT size is not constrained by header limits. Even with 10 domain mapping entries (~800 bytes), the total is well within HTTP response limits.

---

## 8. Summary of Env Var Changes

```bash
# Updated enum
EMAIL_PROVIDER=disabled|smtp|ses|sendgrid

# AWS SES (when EMAIL_PROVIDER=ses)
AWS_REGION=eu-west-1

# SendGrid (when EMAIL_PROVIDER=sendgrid)
SENDGRID_API_KEY=SG.xxx
```

---

## 9. Summary of New/Changed Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /auth/domain-mapping` | GET | Query org/team mapping for an email domain |

No other new endpoints. Existing registration, login, password reset, and 2FA reset endpoints are unchanged in their interface — behavior changes are internal.

---

## 10. Summary of New Dependencies

| Package | Provider | Loading |
|---------|----------|---------|
| `@aws-sdk/client-ses` | AWS SES | Dynamic `import()` — only loaded when `EMAIL_PROVIDER=ses` |
| `@sendgrid/mail` | SendGrid | Dynamic `import()` — only loaded when `EMAIL_PROVIDER=sendgrid` |

Both are optional runtime dependencies. The `smtp` and `disabled` providers remain dependency-free.

---

## 11. Migration & Database Changes

### 11.1 Schema Migration

**One migration required:** Add `VERIFY_EMAIL` to the `VerificationTokenType` enum in `schema.prisma`. This generates an `ALTER TYPE ... ADD VALUE` SQL migration. PostgreSQL enum additions are non-transactional — note this in migration docs for deployments using blue-green or zero-downtime strategies.

No new tables. All other configuration lives in the client config JWT.

### 11.2 Behavior for Existing Users

Domain restrictions are **forward-only** — they apply to new account creation only.

When `allowed_registration_domains` is added to a config that previously had no restrictions:
- **Existing users** with out-of-domain emails (e.g., `@gmail.com`) can still log in. They receive login links as before. Their accounts are not deactivated, blocked, or deleted.
- **New users** with out-of-domain emails are silently blocked from registering.
- If an operator needs to block existing out-of-domain users, they must deactivate those accounts through another mechanism (e.g., direct database action or a future admin tool). This system does not provide retroactive domain enforcement.

---

## 12. Security Considerations

1. **No enumeration** — domain restrictions never change the external response. Whether an email is blocked by domain restriction or simply doesn't exist, the response is identical.
2. **Config is signed** — `allowed_registration_domains` and `registration_domain_mapping` live in the JWT, so they cannot be tampered with by the client.
3. **No wildcard domains** — explicit domain lists prevent accidental over-permissioning.
4. **Social login respects restrictions** — domain restrictions apply to social registration for new users. Existing users are unaffected (see 4.2).
5. **Domain-mapping endpoint is config-verified** — requires valid `config_url`. Reveals org/team names for mapped domains (acceptable trade-off, see 5.3).
6. **Passwordless mode is opt-in** — existing deployments continue requiring passwords by default.
7. **Org placement ownership chain** — auto-placement verifies `org.domain === config.domain` before inserting. Prevents cross-domain placement via misconfigured config.
8. **Null-password users** — `POST /auth/login` runs a timing-safe dummy comparison for users with no password. Rate limiting is the brute-force mitigation (already in place).

---

## 13. Implementation Order

1. **Email providers** — Add `ses` and `sendgrid` providers to `email.service.ts`. Self-contained, no impact on existing flows. Update `env.ts` in the same PR.
2. **`allow_registration` config field** — Add to schema, enforce in `auth-register.service.ts`. Small, testable change.
3. **`allowed_registration_domains` config field** — Add to schema, enforce in registration + social callback. Add cross-field validation.
4. **`registration_mode` config field + `VERIFY_EMAIL` token type** — Schema migration. Refactor `POST /auth/verify-email` to branch on token type. Add new email template. Add Zod cross-validation.
5. **`registration_domain_mapping` config field** — Add to schema, implement auto-placement service (`org-placement.service.ts`), integrate into token consumption and social callback.
6. **`GET /auth/domain-mapping` endpoint** — Query endpoint for client UI.

Each step is independently deployable and testable.

---

## 14. Testing Strategy

### 14.1 Email Provider Tests (unit)

Each provider (`ses`, `sendgrid`, `smtp`, `disabled`):
- Send success path (mock SDK / nodemailer via dependency injection).
- SDK error path — verify error is caught in `dispatchEmail` and does not propagate.
- Missing config (e.g., `AWS_REGION` absent for SES) — verify clear failure at send time.

### 14.2 Registration Control Tests (unit, `auth-register.service.ts`)

- `allow_registration: false` + unknown email → no token created, no email sent, generic response.
- `allow_registration: false` + known email → login link sent (existing user path unchanged).
- `allowed_registration_domains: ["acme.com"]` + new `user@acme.com` → account creation proceeds.
- `allowed_registration_domains: ["acme.com"]` + new `user@gmail.com` → silently dropped.
- `allowed_registration_domains: ["acme.com"]` + existing `user@gmail.com` → login link still sent.

### 14.3 Social Callback Domain Restriction Tests (integration, `callback.ts`)

- Social login, new user, domain in allowed list → user created.
- Social login, new user, domain not in allowed list → user not created, generic error redirect.
- Social login, existing user, domain not in allowed list → user logs in normally.

### 14.4 Passwordless Registration Tests (unit + integration)

- `VERIFY_EMAIL` token consumed → user created with `passwordHash: null`.
- `VERIFY_EMAIL_SET_PASSWORD` token consumed → existing behavior, password set.
- `POST /auth/login` against null-password user → generic failure (timing-safe).
- `POST /auth/register` for existing null-password user → login link sent.
- `allow_registration: false` + `registration_mode: 'passwordless'` → Zod rejects config.

### 14.5 Org Placement Tests (unit, `org-placement.service.ts`)

- New user with matching domain mapping → `OrgMember` + `TeamMember` created.
- Matching domain, `team_id` absent → placed in default team.
- Matching domain, org does not exist in DB → placement skipped, user still created.
- Matching domain, `org.domain !== config.domain` → placement skipped (ownership check).
- User already in org on this domain → placement skipped, no duplicate.
- `OrgMember` + `TeamMember` in transaction: if `TeamMember` fails, entire placement rolls back.

### 14.6 `GET /auth/domain-mapping` Tests (integration)

- Valid config, domain in mapping, org/team exist → `{ mapped: true, ... }`.
- Valid config, domain in mapping, org missing → `{ mapped: false }`.
- Valid config, domain not in mapping → `{ mapped: false }`.
- Valid config, mapping references org on different domain → `{ mapped: false }`.
- Missing `config_url` → 400.
- Invalid/unsigned config JWT → 400.
- Rate limiting: excessive requests from same IP are throttled.

### 14.7 Config Schema Regression Tests

- Existing configs missing all four new fields parse without error and produce expected defaults.
- Duplicate `email_domain` in mapping → Zod rejects.
- `allow_registration: false` + `passwordless` → Zod rejects.
- `allowed_registration_domains: []` (empty array) → Zod rejects.

---

## Appendix: Review Summary

This document was independently reviewed by Claude, Codex, and Gemini. Key findings addressed:

| Finding | Raised By | Resolution |
|---------|-----------|------------|
| `VERIFY_EMAIL` token consumption path unspecified | All three | Section 6.3: refactor `POST /auth/verify-email` to branch on token type |
| Schema migration needed for new enum value | Codex | Section 11.1: migration documented |
| "No schema changes" claim was wrong | Codex | Corrected |
| Domain-mapping endpoint leaks org/team names | Claude, Gemini | Section 5.3: acknowledged as acceptable trade-off with alternative in 5.4 |
| Org placement idempotency and one-org-per-domain | Claude, Codex | Section 5.2: check existing membership, upsert on user creation |
| Cross-domain ownership check on org placement | Gemini | Section 5.2: verify `org.domain === config.domain` |
| Social login domain restriction flow unspecified | All three | Section 4.5: detailed callback behavior |
| Existing users vs domain restrictions | Claude, Gemini | Section 4.2: explicitly forward-only |
| `allow_registration: false` doesn't gate social | Claude | Section 3.2: documented as deliberate, with operator guidance |
| Null-password brute-force via `POST /auth/login` | Gemini | Section 6.3 + 12.8: rate limiting is the mitigation |
| `allow_registration: false` + `passwordless` nonsensical | Gemini | Section 6.3: Zod `.refine()` added |
| Transaction semantics "if possible" was vague | Gemini | Section 5.2: separate operations, explicit policy |
| Bounce/complaint handling | Codex | Section 2.4: out of scope, documented |
| SES sandbox mode | Codex | Section 2.2: operational note added |
| Missing email template for passwordless | Claude | Section 6.3: new template noted |
| `cachedProvider` test isolation | Codex | Section 2.5: `resetEmailProviderCache()` noted |
| Dynamic import vs bundled dependency | Claude | Section 10: dynamic `import()` specified |
| Duplicate `email_domain` in mapping | Claude | Section 5.1: `superRefine` uniqueness check |
| Domain mapping independent of domain restrictions | Claude | Section 5.1: clarified as independent with warning |
| Config JWT size concern | Codex | Section 7: not constrained (HTTP-fetched, not header) |

### Round 2 Review Findings (addressed)

| Finding | Raised By | Resolution |
|---------|-----------|------------|
| `callback.ts` has no `findUnique` — design assumed it did | Claude | Section 4.5: rewritten — pass config into `loginWithSocialProfile` to avoid TOCTOU race |
| `GET /auth/domain-mapping` has no rate limiting | Claude, Gemini | Section 5.3: per-IP rate limit specified |
| `allowed_registration_domains: []` silently passes Zod | Gemini | Section 4.1 + 7: `.min(1)` added to array schema, empty array rejected |
| `registration_mode` interaction with social login unspecified | Gemini | Section 3.2: explicitly stated as no effect |
| Duplicate pending verification tokens on concurrent registration | Codex | Section 5.2: documented as harmless, future refinement path noted |

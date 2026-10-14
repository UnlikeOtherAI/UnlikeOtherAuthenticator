# Canonical profile authority — U3

Draft implementation on the API audit branch. Runtime HTTP/PostgreSQL and
consumer flow checks remain required before deployment/cutover.

UOA is the sole durable profile authority. Products retain stable subjects and
product-specific data; profile results may be used only in bounded memory.

`GET/PATCH /profile/me?domain=...&config_url=...` requires an active domain bearer,
a verified signed configuration and exactly one person credential:
`X-UOA-Access-Token` or a one-minute RS256 `X-UOA-Subject-Assertion` using the
existing exact org audience `https://authentication.unlikeotherai.com/org`.
Malformed, stale, expired, revoked or conflicting credentials fail closed.
Backend-only domain authority and background directory credentials cannot read
or write self. UOA rechecks the current lifecycle, credential epoch, domain role,
product and selected team under locks; expiry is checked after lock waits.

GET returns the stable subject, own current email, name, pronouns, authorized
canonical image URLs, 2FA enabled flag and creation time. It never returns factor
secrets, password material or token version. PATCH is partial and strict:

- `name`: trimmed nonempty text, at most 200 characters.
- `pronouns_preset`: null or he_him, she_her, they_them, any_pronouns, ask_me,
  prefer_not_to_say, custom.
- `pronouns_custom`: null or trimmed nonempty text, at most 120 characters.
  Custom requires text; other presets clear custom text. Display text is derived
  by UOA; clients cannot write an independent display field.

Unsupported fields and empty patches are refused. Email is read-only in this
contract. Current source has no email-change route; a separate verified protocol
is required before a product may offer that mutation. Profile writes emit minimal
ID-only invalidations through the draft U1 transaction seam; complete writer
coverage/U2 delivery is still required before relying on cached authority.

`GET /org/organisations/:orgId/users/:userId/display` requires current ACTIVE
actor standing in the exact claimed org and exact target provenance. Active
members expose only subject, name, deleted:false and an authorized image URL.
Removed members are Former member; other inactive accounts/members are
Unavailable member. Both are neutral and omit avatars. Deleted user is returned
only for exact retained org provenance; unknown, erased or unproven targets are
generic404. A historical domain-wide association is never exact-org permission.
No other-person email or authentication factors are returned.

The self image and exact-org display image routes use the same live credential
boundary. These URLs are authenticated, private/no-store endpoints. Product BFFs
fetch/proxy image bytes with the current authorized context; never put the domain
bearer or subject assertion in an image URL or send the backend secret to a
browser. A plain browser img request cannot supply that backend authority.

The directory DISPLAY_READ grant uses the same minimal target display policy,
with its own purpose-bound credential and live exact-org permission. It grants
no self profile write and exposes neither email nor factors. Products render
neutral presentation on an unresolved/erased reference and must not retain the
last known name/avatar as a durable fallback.

Machine contracts: `API/src/routes/root/schema.profile.ts`, `schema.directory.ts`
and root `/api`. Readable integration contract: `/llm`. Focused authority fixtures
are in `tests/unit/profile-authority.service.test.ts`; these do not replace real
HTTP, RLS, migration and concurrent mutation proofs.

Profile and directory routes set private/no-store before authorization, so refused,
invalid, missing-subject and dependency-error responses carry the same cache
boundary. Server-free HTTP fixtures use Fastify.inject with the production error
handler: profile requests exercise actual HS256 user JWT, domain bearer, epoch
and service checks while seeding the already-verified config result; directory
requests exercise actual purpose/grant/standing/display checks. Avatar byte
resolution is substituted with synthetic bytes. These fixtures open no listener
or DB and do not verify config fetching/JWKS, RLS, upgrades, real races or BFF
rendering. Those runtime proofs remain required.

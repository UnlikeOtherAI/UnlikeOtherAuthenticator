export const llmAvatarsMarkdown = `
---

## User avatars

Every UOA user always has an avatar. The API resolves one with a fixed precedence and the avatar \`GET\` endpoints **always return image bytes, never JSON** — there is no "no avatar" case to handle and no 404 for a known user.

1. **Uploaded** — an image set through UOA (\`PUT\` on any avatar endpoint). Stored in Postgres, one row per user. Wins over everything.
2. **Provider** — the social provider avatar captured in \`avatar_url\`. UOA fetches it server-side and returns the bytes, so the caller never has to hotlink a provider CDN. HTTPS-only, SSRF-guarded, ~5s timeout, 5 MiB cap, and the response must sniff as a raster image. Nothing is persisted.
3. **Generated** — a deterministic, dependency-free SVG UOA draws itself. Always available.

Any provider-fetch failure silently degrades to the generated image; the response is still \`200\` and \`X-UOA-Avatar-Source\` tells you it happened. Apple, which returns no avatar URL, therefore always resolves to \`generated\`.

### Endpoints

| Method | Path | Auth |
| ------ | ---- | ---- |
| GET / PUT / DELETE | \`/domain/users/:userId/avatar?domain=…\` | domain hash bearer — backend-driven administration |
| GET / PUT / DELETE | \`/avatar/me?domain=…\` | domain hash bearer **and** \`X-UOA-Access-Token\` — the end user's own choice, relayed by your backend |
| GET / PUT / DELETE | \`/internal/admin/users/:userId/avatar\` | admin superuser bearer; the mutations are audit-logged |

For \`/domain/users/:userId/avatar\` the user must be visible to the authenticated domain under the same rules as \`GET /domain/users\`; anything else is the standard generic 404. For \`/avatar/me\` the access token's \`domain\` claim must equal \`?domain=\`, and the acting identity is always the token subject — you cannot act for another user through this route. Operators can also set and remove any user's avatar from the Admin panel through \`/internal/admin/users/:userId/avatar\`, audit-logged as \`user.avatar_updated\` / \`user.avatar_deleted\` against that user's domain.

\`PUT\` takes \`multipart/form-data\` with exactly one part named \`file\`: PNG, JPEG or WebP, at most 1 MiB. The stored type is decided by **magic-byte sniffing**, not the mimetype you send — SVG, HTML, PDF and everything else non-raster is rejected with the generic error envelope. It returns \`{ ok, avatar: { source, content_type, size_bytes, updated_at } }\`. \`DELETE\` returns \`{ ok: true }\` and is idempotent; resolution then falls back to the provider URL or the generated image. Both mutations are rate-limited per domain + user, and both are audit-logged as \`domain.user_avatar_updated\` / \`domain.user_avatar_deleted\` against the acting domain. Note that a \`global\`-scope user is one identity shared by every domain they belong to, so the image you set here is the image every other integration renders for that person — the audit row records which domain changed it.

### Generated styles and caching

Four styles: \`tiles\` (symmetric identicon mosaic), \`waves\` (stacked Bézier bands), \`rings\` (offset concentric rings), and \`mono\` (black-and-white geometric pattern). Selection order:

1. \`?style=\` on the GET — one of the four values; use it to preview or pin a style per call.
2. The signed config claim \`avatars.default_style\` for the domain. Pass \`?config_url=\` on the avatar GET to have UOA fetch and verify your config and apply it; its \`domain\` claim must match \`?domain=\`. The fetch happens only after your bearer checks out — an unauthenticated call is rejected before UOA touches the network.
3. Neither → a stable per-user pick derived from the user id.

Generation is deterministic: the same user always gets the same image, so it is safe to cache and it never flickers between styles. \`?size=\` (default 128, clamped 16–512) sets the SVG's rendered width/height — the \`viewBox\` is constant and \`size\` is ignored for raster images.

Every avatar GET responds with \`X-UOA-Avatar-Source: uploaded | provider | generated\`, an \`ETag\` (send it back as \`If-None-Match\` for a \`304\`), \`X-Content-Type-Options: nosniff\`, \`Content-Disposition: inline\`, and \`Cache-Control: private, max-age=300\` for uploaded/proxied images or \`private, max-age=86400\` for generated ones. SVG responses additionally carry \`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\` — generated SVGs contain no scripts, foreign objects, or external references.

Since these endpoints need a bearer credential, a plain \`<img src>\` cannot call them directly: fetch the image with your credential and render the resulting blob/object URL.

\`GET /domain/users\` additionally returns \`avatar_source\` per user so you can label or prioritise without a request per avatar. \`avatar_url\` is unchanged: it remains the provider URL and is still overwritten on every social login, which is exactly why uploads live in their own table and cannot be clobbered by a later sign-in.

### Avatar URLs in identity payloads

You never have to build an avatar URL yourself. **Wherever a JSON response carries a UOA user's identity — a \`userId\` and/or the name/email of a UOA user — it also carries an absolute avatar image URL** that always resolves to an image, and that is fetchable with the *same credential class* you used for that request. Two forms, picked by the context you are already in:

| Context | Field | URL |
| ------- | ----- | --- |
| Domain-hash and dual-auth (\`/domain/*\`, \`/org/*\`) | \`avatar_image_url\` / \`avatarImageUrl\` (each payload keeps its own casing) | \`<PUBLIC_BASE_URL>/domain/users/<userId>/avatar?domain=<domain>\` |
| Admin bearer (\`/internal/admin/*\`) | \`avatarImageUrl\` (\`user_avatar_image_url\` on the snake_case signature rows) | \`<PUBLIC_BASE_URL>/internal/admin/users/<userId>/avatar\` |

So a domain-hash caller listing \`/domain/users\`, org/team/group members, invites or access requests can fetch every returned URL with the bearer it already holds, and an admin-panel caller can do the same with the admin bearer. As with the avatar endpoints themselves, the URL needs that credential — fetch it and render the blob rather than dropping it into \`<img src>\`. Invite records expose \`invitedByAvatarImageUrl\` and \`acceptedAvatarImageUrl\`, both \`null\` until the matching user id exists.

### Team ("company") avatars

Teams have avatars too, and they work **exactly** like user avatars — same four generated styles, same \`?style=\`/\`?size=\`, same upload rules, same response headers, same ETag/\`304\` behaviour. Only the precedence middle step differs:

1. **Uploaded** — an image set through UOA (\`PUT\` on any team avatar endpoint). Stored in Postgres, one row per team.
2. **Icon URL** — the team's \`iconUrl\` (the externally hosted workspace icon from \`PUT /org/organisations/:orgId/teams/:teamId\`). UOA proxies it server-side under the same HTTPS-only, SSRF-guarded, ~5s/5 MiB rules and reports \`X-UOA-Avatar-Source: provider\`. Nothing is persisted, and \`iconUrl\` itself is never modified by the avatar endpoints.
3. **Generated** — the same deterministic SVG generator, seeded from the **team id**.

| Method | Path | Auth |
| ------ | ---- | ---- |
| GET / PUT / DELETE | \`/domain/teams/:teamId/avatar?domain=…\` | domain hash bearer only — **the path your backend wants** |
| GET | \`/org/organisations/:orgId/teams/:teamId/avatar?domain=…&config_url=…\` | the standard \`/org/*\` chain — domain hash bearer + \`X-UOA-Access-Token\` + verified config; any ACTIVE org member may read |
| PUT / DELETE | \`/org/organisations/:orgId/teams/:teamId/avatar?domain=…&config_url=…\` | same chain, **organisation owner/admin only** — the same authorization as updating the team |
| GET / PUT / DELETE | \`/internal/admin/teams/:teamId/avatar\` | admin superuser bearer; the mutations are audit-logged |
| GET | \`/teams/:teamId/avatar\` | **none — public.** The only unauthenticated avatar route |

**The public read.** \`GET /teams/:teamId/avatar\` takes no credential and no \`?domain=\`, so a browser can render a workspace logo straight from an \`<img src>\`. It exists because the auth-window workspace chooser renders in a popup that holds no bearer of any class — every other form above needs one, which a plain \`<img>\` cannot send. It is not an existence oracle: an unknown or deleted team id returns the same deterministic generated SVG a real team with no image would, so every id answers 200 and no id can be probed. Team ids are unguessable cuids; anyone holding one can fetch that workspace's logo. Reads are rate-limited 300/hour per IP, and no \`config_url\` is accepted (an anonymous caller must not be able to aim the config fetcher), so the generated style is always the platform default.

**Which one to call.** Use \`/domain/teams/:teamId/avatar\` from a product backend, and the \`/org/*\` routes only when you actually hold a live end-user access token (flows inside UOA itself). Products keep the bound refresh credential rather than a spendable access token, so the dual-auth \`/org/*\` mutations cannot be driven from a backend at all. The \`/domain/*\` mutations consequently apply **no role check** — per brief §24.10 the domain hash token is full system trust for that domain, exactly as with \`PUT /domain/users/:userId/avatar\`, so enforce your own owner/admin gating before relaying the call.

On every \`/domain/teams/:teamId/avatar\` call the team's organisation must belong to the authenticated domain — a team on another domain is the standard generic 404, exactly like a cross-domain user id. Team mutations are rate-limited 30/hour, keyed per domain + team on \`/domain/*\` and per organisation + team on \`/org/*\`. Because the \`/domain/*\` path enforces no role of its own, its mutations are audit-logged as \`domain.team_avatar_updated\` / \`domain.team_avatar_deleted\` against the acting domain.

Team records in JSON follow the same identity rule as users: **every team record carries \`avatarImageUrl\`**, an absolute URL that always resolves to an image and is fetchable with the credential class you already used — \`<PUBLIC_BASE_URL>/domain/teams/<teamId>/avatar?domain=<domain>\` on \`/org/*\` and \`/internal/org/*\`, \`<PUBLIC_BASE_URL>/internal/admin/teams/<teamId>/avatar\` on \`/internal/admin/*\`. It is never null. \`iconUrl\` is unchanged and keeps its own meaning: the external URL you set, or \`null\` if you set none.

A few payloads deliberately carry **no** avatar URL: bare actor-attribution emails with no user object (\`created_by_email\`, \`published_by_email\`, \`actor_email\`, the signature revocation actor), the frozen billing-statement protocol packages (their schemas reject unknown properties — adding one is a protocol version bump), the admin login-log rows (whose shape drops \`userId\`), the *user* identities in auth-popup chooser payloads (\`/auth/session-choices\`, \`/auth/verify-code\`, \`/auth/select-team\`, the \`/auth/login\` chooser, and \`/org/me\` \`pending_invites.invitedBy\` — browser-popup context with no credentialed fetch), and invite rows for invitees who have no user account yet.

The chooser's **teams**, unlike its users, do carry \`avatarImageUrl\` — in the public \`<PUBLIC_BASE_URL>/teams/<teamId>/avatar\` form, the one URL that needs no credential. That is exactly why the public route exists; the user-identity exclusion above is unchanged, because there is no public user-avatar route to point at.

See [the JSON endpoint contract](/api) and \`Docs/Auth/avatars.md\` for the full specification.
`;

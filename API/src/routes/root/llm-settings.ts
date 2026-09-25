export const llmSettingsMarkdown = `
---

## User settings

Every UOA user can optionally store their own settings in UOA as **namespaced JSON**: namespace → key → any JSON value. Nothing is stored until a product writes something, and nothing in UOA itself reads these values — they exist for products to share per-user state.

Two typical shapes:

- **Structured data** — namespace \`browser\`, key \`bookmarks\`, value an array of \`{ "favicon": "...", "url": "...", "name": "..." }\`.
- **Ecosystem-wide preferences** — namespace \`global\`, keys such as \`theme\` → \`"dark"\` or \`locale\` → \`"en-GB"\`, read by every product the user signs into.

### Endpoints

All routes use the same dual auth as \`/avatar/me\`: your domain hash bearer **and** the end user's access token in \`X-UOA-Access-Token\`, with \`?domain=\` equal to the token's \`domain\` claim. The acting identity is always the token subject — there is no way to read or write another user's settings through these routes.

| Method | Path | Does |
| ------ | ---- | ---- |
| GET | \`/settings/me?domain=…\` | Every namespace, plus \`usage\` against the quota |
| GET | \`/settings/me/:namespace?domain=…\` | One namespace: \`{ ok, namespace, settings: { [key]: value }, updated_at }\` |
| PATCH | \`/settings/me/:namespace?domain=…\` | Body \`{ "settings": { "<key>": <value \\| null>, … } }\` — atomic batch upsert; \`null\` deletes that key |
| DELETE | \`/settings/me/:namespace?domain=…\` | Remove the whole namespace; \`{ ok, deleted }\` |
| GET | \`/settings/me/:namespace/:key?domain=…\` | One key: \`{ ok, namespace, key, value, updated_at }\`; a missing key is the generic 404 |
| PUT | \`/settings/me/:namespace/:key?domain=…\` | Body \`{ "value": <JSON, not null> }\` — create or replace one key |
| DELETE | \`/settings/me/:namespace/:key?domain=…\` | Remove one key; idempotent |

Example — save a user's bookmarks:

\`\`\`http
PUT /settings/me/browser/bookmarks?domain=browser.example.com
Authorization: Bearer <domain hash token>
X-UOA-Access-Token: <user access token>
Content-Type: application/json

{ "value": [ { "favicon": "https://example.com/favicon.ico", "url": "https://example.com/", "name": "Example" } ] }
\`\`\`

### Rules

- **Values replace, they never merge.** A PUT or a PATCH entry replaces the stored value whole, so write a list such as \`bookmarks\` as the complete new list. PATCH is all-or-nothing across its entries.
- **Names.** \`:namespace\` is 1–64 chars of lowercase \`a-z\`, \`0-9\`, \`_\`, \`.\`, \`-\`; \`:key\` is 1–128 chars of \`A-Z\`, \`a-z\`, \`0-9\`, \`_\`, \`.\`, \`-\`. Both start with a letter or digit. A namespace exists only while it has keys; reading an unknown one returns \`settings: {}\`.
- **Values.** Any JSON value except a top-level \`null\` (nested \`null\`s are fine). Max nesting depth 32; strings containing NUL or unpaired surrogates and non-finite numbers are rejected.
- **Quotas.** 256 KiB per serialized value, 500 keys and 1 MiB in total per user, and 1–100 entries per PATCH. Over the value cap is \`413 SETTING_VALUE_TOO_LARGE\`; a write that would exceed the per-user quota is \`413 SETTINGS_QUOTA_EXCEEDED\` and changes nothing. \`GET /settings/me\` reports current \`usage\`.
- **Rate limit.** All settings writes share 600/hour per domain + user. Reads are not rate-limited.
- **Caching.** Every response is \`Cache-Control: no-store\`.

### Who can see what

Settings belong to the **user row**, not to a product. A \`global\`-scope user is one identity across every domain they sign into, so every one of those products sees and can change the same namespaces — that is what makes a shared \`global\` namespace work, and it also means **any product the user uses can read everything stored here**. Never store secrets, credentials or tokens in user settings. Pick a namespace name specific to your product for product-private preferences and treat anything outside it as shared. A \`per_domain\`-scope user has a separate user row per domain, and therefore a separate settings store per domain.

Deleting a user deletes their settings.

See [the JSON endpoint contract](/api) and \`Docs/Auth/user-settings.md\` for the full specification.
`;

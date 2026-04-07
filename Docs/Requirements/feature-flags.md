# Feature Flags & Role Flag Matrix — Requirements

## Status: confirmed, in scope

Both the feature flag service and the role flag matrix are **optional services**. Neither is mandatory for a consuming app that just needs identity and authentication. They are enabled or disabled **per App** via the `feature_flags_enabled` and `role_flag_matrix_enabled` fields on the App model (see `apps.md`). A system admin or org admin toggles these fields from the admin panel.

---

## Two optional services

### Service 1 — Feature Flags

A general-purpose feature flag store scoped to a consuming app's domain or team. The consuming app defines flags, sets their default state, and can query the resolved state for any user at any time.

This replaces the need for every consuming app to build and host its own feature flag system.

### Service 2 — Role Flag Matrix

An extension of the feature flag service. When roles are enabled, each role gets a column in the flag matrix — a set of flag values that apply to all users holding that role. A user's resolved flags are their role's values, with per-user overrides applied on top.

When the role flag matrix is enabled, UOA manages role definitions. When it is disabled, roles are just opaque string labels on membership records (the thin model described in `roles-and-acl.md`).

---

## Feature flag model

### Flag definition

Each flag belongs to an **App** (see `Docs/Requirements/apps.md`). Flags are not shared across Apps — each App is an isolated flag scope.

| Field | Description |
|---|---|
| `key` | Unique string identifier, e.g. `new_checkout`, `dark_mode` (lowercase, underscores only) |
| `description` | Human-readable label for the admin UI |
| `defaultState` | `enabled` or `disabled` — the value returned when no explicit assignment exists for a user |

### Flag resolution order (per user, per flag)

When a consuming app queries a flag for a user, resolution proceeds in order and stops at the first match:

1. **Per-user override** — if an explicit assignment exists for this user in this App, use it
2. **Role assignment** — if the role flag matrix is enabled and the user has a `customRole` assigned on the relevant team, use the flag value defined for that role in the matrix. If the matrix is enabled but the user has no `customRole` assigned, skip to step 3.
3. **Flag default** — use the flag's `defaultState`
4. **Global default** — if the flag key doesn't exist in this App at all, return the global missing-flag default (configurable per org: `enabled` or `disabled`, defaults to `disabled`)

The global missing-flag default means consuming apps never get an error for an undefined flag — they always get a boolean.

**Multi-team context:** A user may have different `customRole` values on different teams within the same org, producing different role flag values. The flag query must specify a team context (`teamId` param) when a user has more than one team membership. If no `teamId` is provided and the user has exactly one team membership, that team's role is used. If no `teamId` is provided and the user has multiple memberships, the tiebreaker is applied in this order: (1) highest UOA system role on that team (`owner > admin`, with users having no named UOA role ranking lowest), (2) if equal, earliest `createdAt` on the `TeamMember` record (the team the user joined first). This tiebreaker uses the effective UOA role (including org-level inheritance). Note: "no named UOA role" (plain member) is not a valid enum value — it simply means neither `owner` nor `admin` is assigned.

### Flag query API

```
GET /apps/:appId/flags?userId=user_123[&teamId=team_xyz]
```

**Auth:** Domain-hash auth (consuming app calling server-side). The `userId` param must correspond to a real user in the calling app's org — the server validates this. When called from a client SDK context, use the `/apps/startup` endpoint instead (which accepts an `X-UOA-Access-Token` header and derives `userId` from it).

`teamId` is optional. When omitted and the user has a single team membership relevant to this App, that team's role is used. When the user has multiple team memberships, `teamId` must be provided or the multi-team fallback rule (see resolution order above) applies.

Returns the fully resolved flag map for that user in that App:

```json
{
  "new_checkout": true,
  "dark_mode": false,
  "beta_access": true,
  "experimental_editor": false
}
```

Flags are resolved server-side. The consuming app receives a flat key→boolean map and checks it directly. No role or matrix logic leaks to the consuming app.

Flags are also embedded in the access token at issue time so the consuming app does not need a separate request on every page load. The `flags` field is **only present in the token when `feature_flags_enabled = true`** on the App. When disabled, the field is omitted entirely (not `{}`). The SDK checks for the field's presence, not its value, to determine if flags are enabled:

```json
{
  "sub": "user_123",
  "flags": {
    "new_checkout": true,
    "dark_mode": false
  }
}
```

Token flags reflect the state at login time. For real-time flag changes without re-login, the consuming app calls the query endpoint directly.

---

## Role flag matrix

When the role flag matrix service is enabled for an App:

- The matrix is **app-wide** — it contains the union of all custom role labels defined on all teams that belong to the same org. There is no per-team matrix; a `customRole` of `"editor"` on any team membership in the org maps to the `editor` column in the App's single matrix.
- If Team A has roles `[viewer, editor]` and Team B has `[viewer, manager]`, the App's matrix has 3 columns: `viewer`, `editor`, `manager`. A `manager` on Team B resolves the `manager` column; an `editor` on Team A resolves the `editor` column.
- UOA manages role definitions for the App (not the consuming app's config JWT)
- Each role has a column of flag values in the matrix
- The matrix is managed entirely from the UOA admin panel, scoped to the App

### Example matrix

| Flag | `viewer` | `editor` | `manager` | `admin` |
|---|---|---|---|---|
| `can_publish` | ✗ | ✓ | ✓ | ✓ |
| `can_edit` | ✗ | ✓ | ✓ | ✓ |
| `can_delete` | ✗ | ✗ | ✓ | ✓ |
| `can_manage_billing` | ✗ | ✗ | ✗ | ✓ |
| `beta_access` | ✗ | ✓ | ✓ | ✓ |

Each cell is a toggle. Rows are flags. Columns are roles.

### Default role

One role per team is marked as default (tick box). New users and auto-enrolled users receive this role. The default role cannot be deleted without reassigning the default first.

### Per-user overrides

Any individual flag can be overridden for a specific user, regardless of their role. This handles exceptions without creating new roles.

Example: a `viewer` who needs temporary `beta_access` gets a per-user override on that single flag rather than a role change.

---

## Service enablement

Services are enabled **per App** (not per org). Two boolean fields on the App model control availability — `feature_flags_enabled` and `role_flag_matrix_enabled`. A system admin or org admin toggles these from the admin panel on a per-App basis. The consuming app does not need to change any code — if flags are not enabled, the query endpoint returns an empty object and the token contains no `flags` field.

| Service | When disabled | When enabled |
|---|---|---|
| Feature Flags | No flag endpoints, no flags in token | Full flag management, query API, flags in token |
| Role Flag Matrix | `customRole` is an opaque string on membership (stored but not resolved against any matrix) | UOA manages role definitions, matrix UI, flags resolved per role |

The feature flags service can be enabled without the role matrix (all flags managed per-user or via defaults). The role matrix is only meaningful when `feature_flags_enabled = true` — enabling `role_flag_matrix_enabled` alone without `feature_flags_enabled` has no effect (no flag resolution occurs, no matrix UI is shown). Use case: you can have feature flags **without** the role matrix (per-user overrides + flag defaults only), but not the role matrix without feature flags enabled.

---

## Admin panel additions required

### Sidebar section — "Flags & Roles"

New section in the sidebar, scoped to the selected App:

- **Feature Flags** — list all flags for the selected App, toggle default state, add/remove flags
- **Role Matrix** — the flag × role grid with toggle cells, role management (add/rename/delete/set default)
- **User Overrides** — per-user flag overrides, searchable by user

### Flag management UI

- Table: key, description, default state (toggle), actions (edit, delete)
- "Add Flag" button → modal: key, description, default state
- Deleting a flag removes all role and user assignments for it. Access tokens already issued containing this flag are not automatically invalidated; the change takes effect on next token issuance or SDK poll.

### Role matrix UI

- Grid view: rows = flags, columns = roles
- Each cell = toggle (on/off)
- "Add Role" button — adds a column
- "Add Flag" button — adds a row (or reuses a flag defined in the flags section)
- Default role indicator (tick icon on column header, clickable to reassign)

### User override UI

- Search for a user
- Shows their resolved flag state with source indicated: `role`, `override`, or `default`
- Toggle any flag to create or remove a per-user override

### Flag management API endpoints

All require org `admin` or `owner` UOA role (domain-hash auth + config JWT).

```
GET    /apps/:appId/flags/definitions              — list all flag definitions for an App
POST   /apps/:appId/flags/definitions              — create a flag  (body: { key, description, defaultState })
PATCH  /apps/:appId/flags/definitions/:flagKey     — update a flag  (body: { description?, defaultState? })
DELETE /apps/:appId/flags/definitions/:flagKey     — delete a flag (cascades: role assignments, user overrides)
```

`GET` response (HTTP 200):
```json
[
  { "key": "dark_mode", "description": "Dark mode UI", "defaultState": "disabled", "createdAt": "2024-01-15T10:00:00Z" },
  { "key": "new_checkout", "description": "New checkout flow", "defaultState": "enabled", "createdAt": "2024-01-16T08:30:00Z" }
]
```

`POST` response (HTTP 201): same shape as a single element from the `GET` response array. Returns HTTP 400 with `{ "error": "Request failed" }` if the key is invalid format, already exists, or the App's `max_flags_per_app` cap is reached.

`PATCH` response (HTTP 200): updated flag object. `PATCH` with an empty body `{}` returns HTTP 400. Unknown fields in body return HTTP 400.

`DELETE` response: HTTP 204 (no body).

### Role matrix API endpoints

```
GET    /apps/:appId/flags/matrix                   — get full matrix (flags × roles grid)
PATCH  /apps/:appId/flags/matrix/:roleName/:flagKey — set cell value (body: { value: boolean })
```

Roles are derived from the team custom role union (see role matrix section). Adding/removing roles is done via the team custom role endpoints in `roles-and-acl.md`.

### Per-user override API endpoints

```
GET    /apps/:appId/flags/overrides/:userId        — get all overrides for a user (resolved state + source)
PUT    /apps/:appId/flags/overrides/:userId        — set one or more overrides (body: { flags: { [key]: boolean } })
DELETE /apps/:appId/flags/overrides/:userId/:flagKey  — remove a specific override
DELETE /apps/:appId/flags/overrides/:userId        — remove all overrides for a user
```

`GET` response (HTTP 200):
```json
{
  "dark_mode": { "value": true, "source": "override" },
  "new_checkout": { "value": false, "source": "role" },
  "beta_access": { "value": false, "source": "default" }
}
```

Source values: `"override"` (explicit per-user assignment), `"role"` (from role matrix), `"default"` (flag's `defaultState`). An unknown `userId` or a `userId` not belonging to this org's App returns HTTP 200 with `{}` (no overrides, no information leak).

`PUT` response (HTTP 200): the updated resolved flag map for the user, same shape as above.

`DELETE` (single flag) response: HTTP 204. `DELETE` (all overrides) response: HTTP 204.

### Feature flags service enablement

Feature flags are enabled per **App** (not per-org globally). Two fields control availability:

- `feature_flags_enabled: boolean` — on the App model. When `false`, `/apps/:appId/flags` returns `{}` (HTTP 200). `/apps/startup` returns `flags: {}`. No flag endpoint is disabled (they return graceful empty responses). Default: `false`.
- `role_flag_matrix_enabled: boolean` — on the App model. When `false`, role matrix resolution (step 2) is skipped entirely. Per-user overrides and flag defaults still apply. Default: `false`.

**`max_flags_per_app`** — org-level config in `org_features` (see `brief.md §24.1`). Default: `100`. Maximum: `500`. When the cap is reached, `POST /apps/:appId/flags/definitions` returns HTTP 400 with `{ "error": "Request failed" }`. Enforced at flag creation time. Existing flags are unaffected when the cap is lowered. The 500 absolute maximum is enforced by Zod schema at config parse time (config JWT rejected if value exceeds 500); the HTTP 400 applies only to the org-level configurable cap.

**`scim_override_retention`** — org-level config in `org_features` (see `brief.md §24.1`). Values: `"retain"` (default) | `"clear"`. Controls per-user override retention on hard-delete only (`DELETE /scim/v2/Users/:id?hardDelete=true`). Soft-deprovision always retains overrides regardless of this setting.

---

## Resolved decisions

1. **Flag key format** — **decided: must start with a lowercase letter, followed by lowercase letters, digits, or underscores** (regex: `[a-z][a-z0-9_]*`). Examples: `dark_mode`, `can_publish`, `beta_access`. Enforced at creation. Validation rejects any other format with HTTP 400. This applies to all flags across all Apps.
2. **Token flag inclusion** — **decided: all flags for the App are included in the token at login time**, regardless of whether they differ from the default. This keeps token consumption simple (no server-side re-resolution needed on read). Orgs with many flags should use `max_flags_per_app` config to cap token size (default 100; see `org_features` in brief.md).
3. **Real-time flag changes** — **decided: poll only**. The token embeds flag state at login. Mid-session changes are visible only via `/apps/:appId/flags` query endpoint calls. The SDK polls on foreground resume (default interval: 5 minutes, minimum 60 seconds, configurable per App). No push mechanism.
4. **SCIM flag sync / override retention** — **decided: soft-deprovision by default**. When a SCIM user is deprovisioned (`active: false`), their per-user flag overrides are **retained** and are re-linked when the user is re-provisioned (matched by email or SCIM `externalId`). Overrides are only deleted when a user is hard-deleted (`DELETE /scim/v2/Users/:id` with `?hardDelete=true` query param, or when the org is deleted). This is the default; orgs can configure `scim_override_retention: "retain" | "clear"` in their `org_features`.

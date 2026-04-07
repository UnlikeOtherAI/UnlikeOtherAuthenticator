# Feature Flags & Role Flag Matrix — Requirements

## Status: confirmed, in scope

Both the feature flag service and the role flag matrix are **optional services**. Neither is mandatory for a consuming app that just needs identity and authentication. They are enabled or disabled per organisation in the UOA admin panel.

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

Each flag belongs to a domain (or team). It has:

| Field | Description |
|---|---|
| `key` | Unique string identifier, e.g. `new_checkout`, `dark_mode` (lowercase, no spaces) |
| `description` | Human-readable label for the admin UI |
| `defaultState` | `enabled` or `disabled` — the value returned when no explicit assignment exists for a user |
| `scope` | `domain` (all teams) or `team` (specific team only) |

### Flag resolution order (per user, per flag)

When a consuming app queries a flag for a user:

1. **Per-user override** — if an explicit assignment exists for this user, use it
2. **Role assignment** — if the role flag matrix is enabled and the user has a role, use the flag value defined for that role
3. **Flag default** — use the flag's `defaultState`
4. **Global default** — if the flag doesn't exist at all, return the global missing-flag default (configurable per org: `enabled` or `disabled`, defaults to `disabled`)

The global missing-flag default means consuming apps never get an error for an undefined flag — they always get a boolean.

### Flag query API

```
GET /flags?domain=api.acme.com&userId=user_123
```

Returns the fully resolved flag map for that user on that domain:

```json
{
  "new_checkout": true,
  "dark_mode": false,
  "beta_access": true,
  "experimental_editor": false
}
```

Flags are resolved server-side. The consuming app receives a flat key→boolean map and checks it directly. No role or matrix logic leaks to the consuming app.

Flags are also embedded in the access token at issue time so the consuming app does not need a separate request on every page load:

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

When the role flag matrix service is enabled for an org or domain:

- UOA manages role definitions (not the consuming app's config JWT)
- Each role has a column of flag values in the matrix
- The matrix is managed entirely from the UOA admin panel

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

Services are enabled per organisation. A system admin can toggle them from the admin panel. The consuming app does not need to change any code — if flags are not enabled, the query endpoint returns an empty object and the token contains no `flags` field.

| Service | When disabled | When enabled |
|---|---|---|
| Feature Flags | No flag endpoints, no flags in token | Full flag management, query API, flags in token |
| Role Flag Matrix | `roleLabel` is an opaque string on membership | UOA manages role definitions, matrix UI, flags resolved per role |

Both services can be enabled independently. You can have feature flags without the role matrix (all flags managed per-user). You can have the role matrix without adding extra flags (matrix defines access, no additional product flags).

---

## Admin panel additions required

### Sidebar section — "Flags & Roles"

New section in the sidebar under Configuration:

- **Feature Flags** — list all flags for the selected domain, toggle default state, add/remove flags
- **Role Matrix** — the flag × role grid with toggle cells, role management (add/rename/delete/set default)
- **User Overrides** — per-user flag overrides, searchable by user

### Flag management UI

- Table: key, description, default state (toggle), scope, actions (edit, delete)
- "Add Flag" button → modal: key, description, default state, scope
- Deleting a flag removes all role and user assignments for it

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

---

## Outstanding decisions

1. **Flag key format** — enforce lowercase + underscores only, or allow any string?
2. **Token flag inclusion** — include all flags in the token, or only flags that differ from the default? (Token size concern for orgs with many flags)
3. **Real-time flag changes** — when a flag is toggled in the admin, should existing sessions see the change immediately (requires query endpoint) or only on next login (token-embedded only)?
4. **SCIM flag sync** — when a user is provisioned via SCIM, their role is set by the IdP group mapping. Per-user flag overrides set in UOA must survive deprovisioning/reprovisioning cycles — define retention policy.

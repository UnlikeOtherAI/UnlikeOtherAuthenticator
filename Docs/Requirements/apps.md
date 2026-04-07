# Apps — Requirements

## The problem this solves

Flags, kill switches, and version enforcement are not properties of a team or organisation. They are properties of a specific client application. An organisation may have:

- An iOS customer app
- An Android customer app
- A web dashboard
- A fleet management tool
- An internal operations app

These five things authenticate against the same org but need independent feature flags, independent kill switches, and independent version tracking. Without an App concept, there is no clean scope to attach these services to.

Teams and orgs are about **people and membership**. Apps are about **client software**. They are related but distinct.

---

## What an App is

An App is a registered client application that uses UOA for authentication and optionally consumes the feature flag and kill switch services.

| Field | Type | Description |
|---|---|---|
| `id` | string (cuid) | Unique identifier |
| `orgId` | string | The organisation this app belongs to |
| `name` | string | Human-readable name, e.g. "Acme iOS App" |
| `identifier` | string | Unique string the SDK uses to identify itself, e.g. `com.acme.ios`. Unique per org. Lowercase, dot-separated (bundle ID style). |
| `platform` | enum | `ios` \| `android` \| `web` \| `macos` \| `windows` \| `other` |
| `domains` | string[] | Array of domain ID strings from the org's domain pool that this app authenticates against. Informational — used for routing and admin display, not access control. |
| `storeUrl` | string (URL) | Default app store / update URL. Optional for non-mobile platforms. |
| `offlinePolicy` | enum | `allow` \| `block` \| `cached` — what the SDK does if UOA is unreachable. Default: `allow`. |
| `pollIntervalSeconds` | integer | How often the SDK re-checks the startup endpoint on foreground resume. Default: `300` (5 minutes). Minimum: `60`. Maximum: `3600`. |
| `feature_flags_enabled` | boolean | Whether the feature flags service is active for this App. Default: `false`. When `false`, flag endpoints return `{}`. |
| `role_flag_matrix_enabled` | boolean | Whether the role flag matrix service is active for this App. Only meaningful when `feature_flags_enabled` is `true`. Default: `false`. |
| `active` | boolean | Whether the app is active. Inactive apps are rejected by the SDK startup endpoint. |
| `createdAt` | datetime | |

### App API endpoints

All endpoints require org `admin` or `owner` UOA role (domain-hash auth + config JWT verification).

```
POST   /org/:orgId/apps           — create an App
GET    /org/:orgId/apps           — list all Apps for an org (paginated, cursor-based)
GET    /org/:orgId/apps/:appId    — get a single App
PATCH  /org/:orgId/apps/:appId    — update App fields (name, storeUrl, offlinePolicy, active, domains, pollIntervalSeconds, feature_flags_enabled, role_flag_matrix_enabled). `identifier` and `platform` are immutable after creation.
DELETE /org/:orgId/apps/:appId    — delete an App (and all its flags, kill switches, per-user overrides, and kill switch metadata)
```

Request body for `POST /org/:orgId/apps`:
```json
{
  "name": "Acme iOS App",
  "identifier": "com.acme.ios",
  "platform": "ios",
  "storeUrl": "https://apps.apple.com/app/acme/id123456789",
  "offlinePolicy": "allow",
  "domains": ["domain_id_1"]
}
```

`DELETE` is destructive — cascades to all kill switch entries and flag definitions for the App. Requires confirmation (`?confirm=true` query param).

An App belongs to an **org**, not a team. Teams manage who has access; Apps define what those people are using.

---

## Hierarchy

```
Organisation
  ├── has many Domains        (backend services / APIs)
  ├── has many Teams
  │     └── Members with roles
  └── has many Apps
        ├── platform + identifier
        ├── uses one or more Domains from the org pool
        ├── Feature Flags     (optional service)
        │     ├── Flag definitions with defaults
        │     ├── Role overrides (flag matrix)
        │     └── Per-user overrides
        └── Kill Switches     (optional service)
              ├── one or more entries per app
              └── each scoped to platform + version range
```

Teams and Apps are siblings under an org. A team member's access to an App is determined by their team membership — they don't register separately for the App. The App is the context in which their flags are resolved.

---

## Feature flags scoped to an App

Feature flags belong to an App. They do not belong to a team or org directly.

**Why this is right:**
- "dark_mode" for the iOS app and "dark_mode" for the web dashboard are independent flags — one might be on, one off
- Org-level flag inheritance across apps would mean changing a flag for the iOS app accidentally affects the web dashboard — wrong
- The natural scope for "what features does this user have" is always "in this specific application"

### Flag inheritance within an App

Within a single App, flags resolve in this order:

1. **Per-user override** — explicit assignment for this user in this App
2. **Role value** — the flag value defined for the user's role in the App's role matrix
3. **Flag default** — the default state defined on the flag itself
4. **Global missing-flag default** — if the flag key doesn't exist in this App at all, return the org's configured missing-flag default (`enabled` or `disabled`)

There is no cross-App flag inheritance. Each App is its own isolated flag scope.

### API

```
GET /apps/:appId/flags?userId=user_123
```

Returns the fully resolved flag map for that user in that App:

```json
{
  "dark_mode": true,
  "new_checkout": false,
  "beta_editor": true
}
```

Also embedded in the access token at login time under the App context.

---

## Kill switches scoped to an App

Kill switches belong to an App. A kill switch entry defines a version range and what to show users on that version.

### Kill switch entry fields

| Field | Type | Description |
|---|---|---|
| `id` | string (cuid) | Unique identifier for this kill switch entry |
| `appId` | string | The App this entry belongs to |
| `name` | string | Internal label for admin UI |
| `platform` | enum | `ios` \| `android` \| `both`. Kill switches do not target web/macOS/windows — for those platforms the kill switch is skipped. |
| `type` | enum | `hard` \| `soft` \| `info` \| `maintenance` |
| `versionField` | enum | `versionName` \| `versionCode` \| `buildNumber` — which field from the SDK request to compare against |
| `operator` | enum | `lt` \| `lte` \| `eq` \| `gte` \| `gt` \| `range`. For `range`: both bounds are **inclusive** (`versionValue <= version <= versionMax`). |
| `versionValue` | string | The threshold value (or lower bound for `range`), e.g. `"2.0.0"` or `"100"`. Always stored as string; comparison uses `versionScheme`. |
| `versionMax` | string \| null | Upper bound for `range` operator (inclusive). Must be present and greater than or equal to `versionValue` when operator is `range` (strictly equal means exact-match range). A zero-width range (same value as `versionValue`) is valid — it matches exactly one version. Null for all other operators. |
| `versionScheme` | enum | `semver` \| `integer` \| `date` \| `custom` |
| `storeUrl` | string (URL) \| null | Override the app's default store URL for this entry |
| `titleKey` | i18n translation key for dialog title |
| `title` | Fallback plain text title if no i18n |
| `messageKey` | i18n translation key for dialog body |
| `message` | Fallback plain text message |
| `primaryButtonKey` | i18n key for the primary button ("Update Now") |
| `primaryButton` | Fallback plain text |
| `secondaryButtonKey` | i18n key for secondary button ("Maybe Later") — soft/info types only |
| `secondaryButton` | Fallback plain text |
| `latestVersion` | Optional — displayed to user as the version they'll get |
| `active` | boolean | Manual on/off toggle |
| `activateAt` | datetime \| null | Scheduled activation datetime — goes live automatically. Until `activateAt`, the entry is not evaluated for non-test users. A `hard` or `maintenance` entry with a future `activateAt` does NOT block immediately — the SDK receives `activatesIn` (seconds) and stays silent until activation. |
| `deactivateAt` | datetime \| null | Scheduled deactivation datetime. Entry stops matching after this time. |
| `priority` | integer | 0–1000 (default 0). Highest value wins when multiple entries match. Equal priority: earliest `createdAt` wins; if still equal, ascending `id` order. |
| `testUserIds` | string[] | User IDs who see this kill switch regardless of `active` flag and `activateAt` scheduling. Bypasses scheduling and on/off toggle — test users always see the entry if it matches their version. Empty array means no test users. |
| `cacheTtl` | integer (seconds) | How long the SDK should cache this response. Minimum: 0 (no cache). |

### Kill switch types

| Type | Dialog behaviour | Dismissable |
|---|---|---|
| `hard` | Blocks app entirely. Primary button only ("Update Now"). Cannot proceed. | No |
| `soft` | Warning dialog. Primary ("Update") + Secondary ("Maybe Later"). User can continue. | Yes |
| `info` | Informational only. Non-blocking. Can be a banner or toast. | Yes |
| `maintenance` | App is down. No version check. Shows maintenance message. Primary button is "Retry". | No |

**Response shapes by type:**
- `hard` and `maintenance` entries always produce `"status": "blocked"` with the full `killSwitch` object.
- `soft` and `info` entries produce `"status": "warning"` with the full `killSwitch` object. The SDK shows the dialog but does not block app launch. The user may dismiss and proceed.
- If no entry matches, the response is `"status": "ok"`.

Example response for `soft`/`info`:
```json
{ "status": "warning", "killSwitch": { "type": "soft", "title": "Update Available", ... }, "cacheTtl": 3600 }
```

### Version scheme support

| Scheme | Example | Comparison |
|---|---|---|
| `semver` | `1.2.3`, `2.0.0-beta.1` | Standard semver ordering |
| `integer` | `1042`, `20240115` | Numeric comparison |
| `date` | `2024.01.15`, `20240115` | Parsed as date, chronological |
| `custom` | Any string | Lexicographic, or define explicit ordering in admin |

iOS apps provide `versionName` (CFBundleShortVersionString) and `buildNumber` (CFBundleVersion). Android apps provide `versionName` and `versionCode`. The kill switch entry specifies which field to compare against.

### Kill switch entry management API

All endpoints require org `admin` or `owner` UOA role (domain-hash auth + config JWT verification).

```
POST   /org/:orgId/apps/:appId/killswitches          — create a kill switch entry
GET    /org/:orgId/apps/:appId/killswitches          — list all entries for an App (paginated, cursor-based)
GET    /org/:orgId/apps/:appId/killswitches/:id      — get a single entry
PATCH  /org/:orgId/apps/:appId/killswitches/:id      — update entry fields (all fields except id, appId, createdAt)
DELETE /org/:orgId/apps/:appId/killswitches/:id      — delete an entry
```

`POST` body accepts all kill switch entry fields (`platform`, `type`, `versionField`, `versionValue`, `versionMax`, `versionScheme`, `name`, `titleKey`, `title`, `messageKey`, `message`, `primaryButtonKey`, `primaryButton`, `secondaryButtonKey`, `secondaryButton`, `latestVersion`, `active`, `activateAt`, `deactivateAt`, `priority`, `testUserIds`, `cacheTtl`). Required fields: `platform`, `type`, `versionField`, `versionValue`, `versionScheme`. All others are optional. Returns HTTP 201 on creation with the full entry.

`DELETE` is idempotent — deleting a non-existent entry returns HTTP 404.

### Kill switch query API

**Authentication:** This endpoint is intentionally public (no bearer token required). It identifies the app by `appIdentifier` (a registered, non-secret identifier). Optionally the SDK may attach the domain-hash bearer token for the org's domain if available, but it is not required. The `userId` param, if provided, must be a valid user ID — it is not authenticated here (used only for test mode targeting).

**Unknown `appIdentifier`:** Returns `{ "status": "ok", "cacheTtl": 3600 }` — same as the "clear" response. No information is leaked about unregistered apps.

```
GET /killswitch/check
  ?appIdentifier=com.acme.ios
  &platform=ios
  &versionName=1.5.0
  &buildNumber=142
  &userId=user_123        (optional — for user-targeted test mode)
```

Response when blocked:

```json
{
  "status": "blocked",
  "killSwitch": {
    "type": "hard",
    "titleKey": "ks.update_required.title",
    "title": "Update Required",
    "messageKey": "ks.update_required.body",
    "message": "This version is no longer supported. Please update to continue.",
    "primaryButtonKey": "ks.button.update",
    "primaryButton": "Update Now",
    "secondaryButton": null,
    "storeUrl": "https://apps.apple.com/app/acme/id123456789",
    "latestVersion": "2.1.0",
    "cacheTtl": 300
  }
}
```

Response when a kill switch has a future `activateAt` (not yet blocking, but approaching):

```json
{
  "status": "ok",
  "activatesIn": 540,
  "cacheTtl": 540
}
```

`activatesIn` is the number of seconds until the nearest pending kill switch activates. When `activatesIn ≤ 900` (15 minutes), `cacheTtl` is capped to `activatesIn` so the SDK re-polls before activation. The kill switch entry is not present in the response until it activates.

Response when clear:

```json
{
  "status": "ok",
  "cacheTtl": 3600
}
```

### SDK behaviour on network failure

Configurable per App:
- `allow` — if UOA is unreachable, let the user in (default for most apps)
- `block` — if UOA is unreachable, block with an offline message
- `cached` — use last cached response; if no cache exists, fall back to `allow`

---

## Combined startup response

To avoid multiple round trips, the SDK can request everything it needs in one call at app launch:

**Authentication:** Same as `/killswitch/check` — publicly accessible by `appIdentifier`. If the user is authenticated, pass `userId` and the user's UOA access token in `X-UOA-Access-Token` header. When the access token is present and valid, the user's per-user flag overrides are applied. Without it, flags resolve against the role default or flag default only.

```
GET /apps/startup
  ?appIdentifier=com.acme.ios
  &platform=ios
  &versionName=1.5.0
  &buildNumber=142
  &userId=user_123         (optional — when authenticated; required for per-user flag overrides)
  &teamId=team_xyz         (optional — for multi-team flag resolution; see feature-flags.md multi-team rule)
```

Response:

```json
{
  "killSwitch": { ... } | null,
  "activatesIn": 540,
  "flags": { "dark_mode": true, "new_checkout": false },
  "cacheTtl": 300,
  "serverTime": "2026-04-07T10:00:00Z"
}
```

- `killSwitch` — the matched kill switch entry (see kill switch response shape above), or `null` if no entry matches. The `cacheTtl` on the `killSwitch` object (when present) is the kill-switch-specific TTL. The top-level `cacheTtl` is the SDK's cache TTL for the entire startup response.
- `flags` — resolved flag map. Empty object `{}` if feature flags service is disabled for this App.
- `serverTime` — ISO 8601 UTC timestamp. SDK should check against local clock; if skew > 60 seconds, log a warning. No automatic blocking on skew.

One endpoint. SDK checks kill switch first — if `hard` or `maintenance` block, show dialog, stop. Otherwise load flags and continue.

**Failure matrix:**

| Scenario | Response |
|---|---|
| Unknown `appIdentifier` | `{ "status": "ok", "flags": {}, "cacheTtl": 3600, "serverTime": "..." }` |
| App `active: false` | `{ "status": "ok", "flags": {}, "cacheTtl": 3600, "serverTime": "..." }` — same as unknown (no information leaked) |
| Missing or expired `X-UOA-Access-Token` | Proceed without per-user overrides; resolve flags against role default. No error. |
| Invalid (tampered) `X-UOA-Access-Token` | Treated as absent — resolve flags against role default. No error. |
| Feature flags service disabled for App | `flags: {}` in response; kill switch check proceeds normally. |
| Invalid `platform` value | HTTP 400, `{ "error": "Request failed" }` |
| Missing `appIdentifier` param | HTTP 400, `{ "error": "Request failed" }` |

**`activateAt` scheduling:** When a kill switch entry has an `activateAt` time in the future, the response includes an `activatesIn` field (seconds until activation). If `activatesIn` ≤ 900 (15 minutes), the SDK must re-poll after that interval rather than using the full `cacheTtl`. This ensures kill switches activate promptly.

---

## SDK targets

Four SDK targets are required:

| SDK | Language | Platform |
|---|---|---|
| `uoa-swift` | Swift | iOS, macOS |
| `uoa-kotlin` | Kotlin | Android |
| `uoa-flutter` | Dart | iOS + Android (Flutter) |
| `uoa-react-native` | TypeScript | iOS + Android (React Native) |

All four SDKs expose the same conceptual API. Native SDKs (Swift, Kotlin) have first-class platform dialog support. Cross-platform SDKs (Flutter, React Native) expose the raw response and provide optional pre-built dialog widgets/components, since UI conventions vary more across cross-platform apps.

## SDK requirements (all targets)

Every SDK must:

- Call `/apps/startup` on launch (or on foreground resume — configurable interval)
- Cache response locally with the `cacheTtl` returned by the server
- Check kill switch first — if `hard` or `maintenance`, block and show dialog before anything else loads
- Show the appropriate dialog type automatically (native dialog by default)
- Support custom UI via a callback/delegate/builder for apps that want their own dialog
- Handle network failure per the App's configured offline policy (`allow` / `block` / `cached`)
- Expose a `flags` accessor: `UOA.flags["dark_mode"]` → `Bool` — returns org's missing-flag default if key not found, never throws
- Support test mode: force a specific kill switch response for a nominated test device or user
- Support async/await (Swift, Kotlin, Dart) and Future/Promise patterns
- Support scheduled activation — SDK re-checks when a `activateAt` time is in the near future
- Pass `userId` in the startup request when a user is authenticated, for per-user flag overrides
- Include `serverTime` from response to detect significant clock skew

### Platform-specific notes

**Swift (iOS/macOS)**
- Present `UIAlertController` (iOS) or `NSAlert` (macOS) automatically
- Support SwiftUI environment via a ViewModifier: `.uoaKillSwitch()`
- App store URL opens via `UIApplication.open` / `NSWorkspace.open`

**Kotlin (Android)**
- Present `AlertDialog` (Material) automatically
- Support Jetpack Compose via a `@Composable` wrapper
- App store URL opens via `Intent.ACTION_VIEW` targeting Google Play
- Use `versionCode` (integer) and `versionName` (string) from `BuildConfig`

**Flutter**
- Pre-built `UOAKillSwitchWrapper` widget wraps the app widget tree
- Exposes raw response for custom UI via `UOAService.startupResponse`
- Flag accessor: `UOAService.flag("dark_mode", defaultValue: false)`

**React Native**
- Pre-built `<UOAKillSwitchProvider>` wraps the app
- Exposes `useFlags()` hook and `useKillSwitch()` hook
- Automatic `Alert.alert()` for kill switch dialogs, overridable via prop

---

## Resolved decisions

1. **App-level vs team-scoped apps** — **decided: Apps always belong to an Org, never to a specific team.** Team scoping is done via membership, not App ownership. The flag matrix uses team custom role labels as column names, but the App itself is org-level.

2. **Web app versioning** — **decided: use `semver` scheme with `versionName` only.** Web apps pass their semver tag (e.g. `1.5.0`) or deploy timestamp (as a date scheme, e.g. `2024.01.15`) as `versionName`. `buildNumber` is optional for web. The `versionScheme` field on the kill switch entry specifies which scheme to use.

3. **Flag sync in token vs query / polling interval** — **decided: SDK polls on foreground resume, minimum 60 seconds between checks, default 5 minutes.** This is configurable per App (see `pollIntervalSeconds` field — to be added to App data model as an optional integer, default 300, minimum 60). Token-embedded flags are login-time snapshots; mid-session changes require poll.

4. **Multiple matching kill switches** — **decided: highest `priority` integer wins.** If two entries have identical priority, the one with the earlier `createdAt` wins (first created takes precedence). This must be deterministic — no random tiebreaking. The `priority` field is an integer from 0 to 1000 (default 0). Entries with the same priority and `createdAt` are processed in ascending `id` order as a final tiebreaker.

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

| Field | Description |
|---|---|
| `id` | Unique identifier |
| `orgId` | The organisation this app belongs to |
| `name` | Human-readable name, e.g. "Acme iOS App" |
| `identifier` | Unique string the SDK uses to identify itself, e.g. `com.acme.ios` |
| `platform` | `ios` \| `android` \| `web` \| `macos` \| `windows` \| `other` |
| `domains` | One or more domains from the org's domain pool that this app connects to |
| `storeUrl` | Default app store / update URL (can be overridden per kill switch) |
| `active` | Whether the app is active |
| `createdAt` | |

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

| Field | Description |
|---|---|
| `id` | |
| `appId` | The App this applies to |
| `name` | Internal label for admin UI |
| `platform` | `ios` \| `android` \| `both` |
| `type` | `hard` \| `soft` \| `info` \| `maintenance` |
| `versionField` | `versionName` \| `versionCode` \| `buildNumber` — which field to compare |
| `operator` | `lt` \| `lte` \| `eq` \| `gte` \| `gt` \| `range` |
| `versionValue` | The threshold value, e.g. `"2.0.0"` or `100` |
| `versionMax` | Upper bound for `range` operator |
| `versionScheme` | `semver` \| `integer` \| `date` \| `custom` |
| `storeUrl` | Override the app's default store URL for this entry |
| `titleKey` | i18n translation key for dialog title |
| `title` | Fallback plain text title if no i18n |
| `messageKey` | i18n translation key for dialog body |
| `message` | Fallback plain text message |
| `primaryButtonKey` | i18n key for the primary button ("Update Now") |
| `primaryButton` | Fallback plain text |
| `secondaryButtonKey` | i18n key for secondary button ("Maybe Later") — soft/info types only |
| `secondaryButton` | Fallback plain text |
| `latestVersion` | Optional — displayed to user as the version they'll get |
| `active` | Manual on/off toggle |
| `activateAt` | Scheduled activation datetime — goes live automatically |
| `deactivateAt` | Scheduled deactivation datetime |
| `priority` | Integer — if multiple entries match, highest priority wins |
| `testUserIds` | List of user IDs who see this kill switch in test mode only |
| `cacheTtl` | How long the SDK should cache this response (seconds) |

### Kill switch types

| Type | Dialog behaviour | Dismissable |
|---|---|---|
| `hard` | Blocks app entirely. Primary button only ("Update Now"). Cannot proceed. | No |
| `soft` | Warning dialog. Primary ("Update") + Secondary ("Maybe Later"). User can continue. | Yes |
| `info` | Informational only. Non-blocking. Can be a banner or toast. | Yes |
| `maintenance` | App is down. No version check. Shows maintenance message. Primary button is "Retry". | No |

### Version scheme support

| Scheme | Example | Comparison |
|---|---|---|
| `semver` | `1.2.3`, `2.0.0-beta.1` | Standard semver ordering |
| `integer` | `1042`, `20240115` | Numeric comparison |
| `date` | `2024.01.15`, `20240115` | Parsed as date, chronological |
| `custom` | Any string | Lexicographic, or define explicit ordering in admin |

iOS apps provide `versionName` (CFBundleShortVersionString) and `buildNumber` (CFBundleVersion). Android apps provide `versionName` and `versionCode`. The kill switch entry specifies which field to compare against.

### Kill switch query API

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

```
GET /apps/startup
  ?appIdentifier=com.acme.ios
  &platform=ios
  &versionName=1.5.0
  &buildNumber=142
  &userId=user_123
```

Response:

```json
{
  "killSwitch": { ... } | null,
  "flags": { "dark_mode": true, "new_checkout": false },
  "cacheTtl": 300,
  "serverTime": "2026-04-07T10:00:00Z"
}
```

One endpoint. SDK checks kill switch first — if `hard` block, show dialog, stop. Otherwise load flags and continue.

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

## Outstanding decisions

1. **App-level vs team-scoped apps** — currently Apps belong to an Org. Should an App be optionally scoped to a specific team (so only that team's members are subject to its flags)? Or is team scoping always done via membership, never via App ownership?
2. **Web app versioning** — web apps don't have a versionCode/buildNumber in the same way. Use commit SHA, deploy timestamp, or semver tag?
3. **Flag sync in token vs query** — flags embedded in the access token reflect state at login time. If a kill switch fires mid-session, the SDK needs to detect it via the startup poll. Define the recommended polling interval.
4. **Multiple matching kill switches** — if two entries match (e.g. a hard block and a soft warning for the same version range), priority field resolves it. Confirm: highest `priority` integer wins, or first created?

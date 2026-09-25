// The only internal error codes that survive the production generic-body
// squash (`buildPublicErrorBody` / the error handler's debug gate). Everything
// else answers with the generic public error body so refusals cannot become an
// enumeration oracle. Add a code here only when a caller must branch on it and
// the code reveals nothing the caller is not already entitled to know.
export const PRODUCTION_PUBLIC_ERROR_CODES = new Set([
  'PASSWORD_POLICY_VIOLATION',
  'MISSING_PASSWORD',
  'INVALID_TOKEN',
  'INVALID_TOKEN_TYPE',
  'INVALID_TOKEN_CONFIG_URL',
  'INVALID_TOKEN_USER',
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'TEAM_NOT_AVAILABLE',
  'INTERACTION_REQUIRED',
  'TEAM_SWITCH_CONFLICT',
  // Invitation revoke (DELETE .../invitations/:inviteId): products branch on the 409's code, so it
  // must survive the production generic-body squash. Not an oracle — the caller was already
  // authorized for the exact invite.
  'INVITATION_ALREADY_ACCEPTED',
  // An authenticated platform superuser already knows the exact organisation. This code lets the
  // Admin UI distinguish durable billing/commercial FK protection from an otherwise generic 400.
  'ORG_HAS_PROTECTED_RECORDS',
  // Creating an organisation whose address is already held: the person is asked to pick another
  // name. Not an oracle — `/auth/slug-available` and `/domain/slug-available` already answer
  // "taken" for the same label.
  'ORG_SLUG_TAKEN',
  // Accepting an invitation for a person whose membership in that organisation or team is
  // DEACTIVATED (an administrative suspension an invitation must not lift). Not an oracle: the
  // backend-mode caller can already list `?status=DEACTIVATED`, and the invitee learns only their
  // own state. The hosted invitation page still renders the generic "This invitation can’t be used".
  'MEMBERSHIP_DEACTIVATED',
  // Confidential token exchange (`POST /auth/token`, RFC 8693 grant) refusing a subject because of
  // the person's own current state: a moved credential epoch, an unknown user, a lost
  // source-domain role, or a selected organisation/team no longer available to them. The caller
  // must branch on it to ask the person to sign in again. Not an oracle: it is reached only after
  // domain-hash authentication, every one of those reasons shares this one code, and the product's
  // own configuration refusals (TOKEN_EXCHANGE_TEAM_CONTEXT_*, TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED)
  // are decided before any subject lookup and stay generic.
  'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN',
  // User settings writes over the per-value cap or the per-user quota (Docs/Auth/user-settings.md
  // §3): products branch on these to tell the user their storage is full. Not an oracle — the
  // caller is already authenticated as the user whose own store it is.
  'SETTING_VALUE_TOO_LARGE',
  'SETTINGS_QUOTA_EXCEEDED',
]);

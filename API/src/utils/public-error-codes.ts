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
  'WORKSPACE_NOT_AVAILABLE',
  'INTERACTION_REQUIRED',
  'WORKSPACE_SWITCH_CONFLICT',
  // Invitation revoke (DELETE .../invitations/:inviteId): products branch on the 409's code, so it
  // must survive the production generic-body squash. Not an oracle — the caller was already
  // authorized for the exact invite.
  'INVITATION_ALREADY_ACCEPTED',
  // An authenticated platform superuser already knows the exact organisation. This code lets the
  // Admin UI distinguish durable billing/commercial FK protection from an otherwise generic 400.
  'ORG_HAS_PROTECTED_RECORDS',
]);

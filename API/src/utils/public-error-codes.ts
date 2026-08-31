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
  // Invitation acceptance (backend accept route AND the invitee-facing chooser/select-team
  // paths): products and hosted surfaces branch on this code because retrying can never succeed
  // while the acceptor belongs to another organisation on the invite's origin domain. Exposing it
  // on the invitee-facing paths is deliberate: it tells an authenticated invitee a fact about
  // their OWN memberships (never anyone else's), which is what lets every surface explain the
  // dead end instead of showing a mute 400.
  'ORG_CONFLICT_ON_DOMAIN',
]);

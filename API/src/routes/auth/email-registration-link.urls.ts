/**
 * The `/auth?…` continuation URLs `GET /auth/email/link` redirects or server-renders to.
 *
 * They live beside the route rather than inside it because each one encodes a convention the
 * route must apply consistently — chiefly that an already-verified PKCE challenge is carried
 * across every `/auth` hop, and that only allow-listed values ever reach the query string.
 */
import type { PkceChallenge } from '../../utils/pkce.js';

/**
 * F5: `redirect_url` rides the invite-registration continuation so the SPA's
 * "Invitation accepted" view can offer a way into the product. It is only ever the
 * allow-listed value resolved by `resolveInviteContinueUrl`, never the raw query param.
 */
export function buildInviteRegistrationAuthUrl(
  configUrl: string,
  token: string,
  email: string,
  continueUrl?: string,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  params.set('invite_token', token);
  params.set('invite_email', email);
  if (continueUrl) params.set('redirect_url', continueUrl);
  return `/auth?${params.toString()}`;
}

export function buildAuthUrl(
  configUrl: string,
  redirectUrl: string | undefined,
  token: string,
  type: string,
  requestAccess: boolean,
  pkce: PkceChallenge,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  params.set('code_challenge', pkce.codeChallenge);
  params.set('code_challenge_method', pkce.codeChallengeMethod);
  params.set('email_token', token);
  params.set('email_token_type', type);
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

// Gap-fix B Task 1 (design §4.3/§11.2): the same `/auth?...&login_token=...&flow=team_chooser`
// shape `callback.ts`'s social team-chooser branch redirects to, adapted to this route's own
// convention of always preserving the (already-verified) PKCE challenge across an `/auth` redirect —
// see `buildAuthUrl`/`buildLoginAuthUrl` above, which do the same for their own redirect targets.
export function buildTeamChooserAuthUrl(
  configUrl: string,
  redirectUrl: string,
  loginToken: string,
  requestAccess: boolean,
  pkce: PkceChallenge,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  params.set('redirect_url', redirectUrl);
  params.set('code_challenge', pkce.codeChallenge);
  params.set('code_challenge_method', pkce.codeChallengeMethod);
  params.set('login_token', loginToken);
  params.set('flow', 'team_chooser');
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

export function buildTwoFaAuthUrl(
  configUrl: string,
  redirectUrl: string,
  continuation:
    | { requestAccess: boolean; kind: 'challenge'; token: string }
    | { requestAccess: boolean; kind: 'enrollment'; token: string },
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  params.set('redirect_url', redirectUrl);
  if (continuation.kind === 'challenge') {
    params.set('twofa_token', continuation.token);
  } else {
    params.set('twofa_enroll_required', 'true');
    params.set('twofa_setup_token', continuation.token);
  }
  if (continuation.requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

export function buildLoginAuthUrl(
  configUrl: string,
  redirectUrl: string | undefined,
  requestAccess: boolean,
  pkce: PkceChallenge | undefined,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  if (pkce) {
    params.set('code_challenge', pkce.codeChallenge);
    params.set('code_challenge_method', pkce.codeChallengeMethod);
  }
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}

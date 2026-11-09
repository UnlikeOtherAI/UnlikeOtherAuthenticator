import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { buildAppleAuthorizationUrl } from './apple.service.js';
import { buildFacebookAuthorizationUrl } from './facebook.service.js';
import { buildGitHubAuthorizationUrl } from './github.service.js';
import { buildGoogleAuthorizationUrl } from './google.service.js';
import { buildLinkedInAuthorizationUrl } from './linkedin.service.js';
import { buildXAuthorizationUrl } from './x.service.js';
import type { SocialProviderKey } from './provider.base.js';

/** Website and native flows share provider credentials and exact callback URLs. */
export function buildSocialAuthorizationUrl(params: {
  provider: SocialProviderKey; baseUrl: string; state: string; codeVerifier?: string; selectAccount?: boolean;
}): string {
  const env = getEnv();
  const credentials = {
    google: [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
    apple: [env.APPLE_CLIENT_ID, env.APPLE_TEAM_ID, env.APPLE_KEY_ID, env.APPLE_PRIVATE_KEY],
    facebook: [env.FACEBOOK_CLIENT_ID, env.FACEBOOK_CLIENT_SECRET],
    github: [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET],
    linkedin: [env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET],
    x: [env.X_CLIENT_ID, env.X_CLIENT_SECRET],
  };
  const [clientId] = credentials[params.provider];
  if (!clientId || !credentials[params.provider].every(Boolean)) {
    throw new AppError('INTERNAL', 500, `${params.provider.toUpperCase()}_ENV_MISSING`);
  }
  const input = { clientId, state: params.state, redirectUri: `${params.baseUrl}/auth/callback/${params.provider}` };
  switch (params.provider) {
    case 'google': return buildGoogleAuthorizationUrl({ ...input, selectAccount: params.selectAccount });
    case 'apple': return buildAppleAuthorizationUrl(input);
    case 'facebook': return buildFacebookAuthorizationUrl(input);
    case 'github': return buildGitHubAuthorizationUrl(input);
    case 'linkedin': return buildLinkedInAuthorizationUrl(input);
    case 'x':
      if (!params.codeVerifier) throw new AppError('INTERNAL', 500, 'X_PKCE_REQUIRED');
      return buildXAuthorizationUrl({ ...input, codeVerifier: params.codeVerifier });
  }
}

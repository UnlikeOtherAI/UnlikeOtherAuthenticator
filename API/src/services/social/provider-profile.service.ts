import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getAppleProfileFromCode } from './apple.service.js';
import { getFacebookProfileFromCode } from './facebook.service.js';
import { getGitHubProfileFromCode } from './github.service.js';
import { getGoogleProfileFromCode } from './google.service.js';
import { getLinkedInProfileFromCode } from './linkedin.service.js';
import type { SocialProfile } from './provider.base.js';

export async function getSocialProfileFromCode(
  provider: 'google' | 'apple' | 'facebook' | 'github' | 'linkedin',
  code: string,
  baseUrl: string,
): Promise<SocialProfile> {
  const env = getEnv();

  let profile: SocialProfile;
  if (provider === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError('INTERNAL', 500, 'GOOGLE_ENV_MISSING');
    }

    const redirectUri = `${baseUrl}/auth/callback/google`;
    profile = await getGoogleProfileFromCode({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri,
    });
  } else if (provider === 'facebook') {
    if (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET) {
      throw new AppError('INTERNAL', 500, 'FACEBOOK_ENV_MISSING');
    }

    const redirectUri = `${baseUrl}/auth/callback/facebook`;
    profile = await getFacebookProfileFromCode({
      code,
      clientId: env.FACEBOOK_CLIENT_ID,
      clientSecret: env.FACEBOOK_CLIENT_SECRET,
      redirectUri,
    });
  } else if (provider === 'github') {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      throw new AppError('INTERNAL', 500, 'GITHUB_ENV_MISSING');
    }

    const redirectUri = `${baseUrl}/auth/callback/github`;
    profile = await getGitHubProfileFromCode({
      code,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      redirectUri,
    });
  } else if (provider === 'apple') {
    if (
      !env.APPLE_CLIENT_ID ||
      !env.APPLE_TEAM_ID ||
      !env.APPLE_KEY_ID ||
      !env.APPLE_PRIVATE_KEY
    ) {
      throw new AppError('INTERNAL', 500, 'APPLE_ENV_MISSING');
    }

    const redirectUri = `${baseUrl}/auth/callback/apple`;
    profile = await getAppleProfileFromCode({
      code,
      clientId: env.APPLE_CLIENT_ID,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_KEY_ID,
      privateKeyPem: env.APPLE_PRIVATE_KEY,
      redirectUri,
    });
  } else if (provider === 'linkedin') {
    if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
      throw new AppError('INTERNAL', 500, 'LINKEDIN_ENV_MISSING');
    }

    const redirectUri = `${baseUrl}/auth/callback/linkedin`;
    profile = await getLinkedInProfileFromCode({
      code,
      clientId: env.LINKEDIN_CLIENT_ID,
      clientSecret: env.LINKEDIN_CLIENT_SECRET,
      redirectUri,
    });
  } else {
    throw new AppError('BAD_REQUEST', 400);
  }
  return profile;
}

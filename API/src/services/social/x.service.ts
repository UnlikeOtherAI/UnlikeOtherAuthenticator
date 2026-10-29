import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const USER_URL = 'https://api.x.com/2/users/me';

export function generateXCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function buildXAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'tweet.read users.read users.email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', createHash('sha256').update(params.codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function getXProfileFromCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<SocialProfile> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'X_TOKEN_EXCHANGE_FAILED');
  }
  if (!tokenResponse.ok) throw new AppError('UNAUTHORIZED', 401, 'X_TOKEN_EXCHANGE_FAILED');
  const token = (await tokenResponse.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = token?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new AppError('UNAUTHORIZED', 401, 'X_TOKEN_EXCHANGE_FAILED');
  }

  const url = new URL(USER_URL);
  url.searchParams.set('user.fields', 'confirmed_email,name,profile_image_url');
  let userResponse: Response;
  try {
    userResponse = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'X_USERINFO_FAILED');
  }
  if (!userResponse.ok) throw new AppError('UNAUTHORIZED', 401, 'X_USERINFO_FAILED');
  const user = (await userResponse.json().catch(() => null)) as Record<string, unknown> | null;
  const data = user?.data as Record<string, unknown> | undefined;
  // X only returns confirmed_email for the authenticated user with users.email access.
  const email = data?.confirmed_email;
  if (typeof email !== 'string' || !email.trim()) {
    throw new AppError('UNAUTHORIZED', 401, 'X_EMAIL_MISSING');
  }
  return validateSocialProfile({
    provider: 'x',
    email,
    emailVerified: true,
    name: typeof data?.name === 'string' && data.name.trim() ? data.name : null,
    avatarUrl: typeof data?.profile_image_url === 'string' && data.profile_image_url.trim()
      ? data.profile_image_url : null,
  });
}

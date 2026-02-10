import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

const FACEBOOK_AUTHORIZE_URL = 'https://www.facebook.com/dialog/oauth';
const FACEBOOK_TOKEN_URL = 'https://graph.facebook.com/oauth/access_token';
const FACEBOOK_ME_URL = 'https://graph.facebook.com/me';

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

export function buildFacebookAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(FACEBOOK_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  // Request only what we need.
  u.searchParams.set('scope', 'email public_profile');
  u.searchParams.set('state', params.state);
  return u.toString();
}

async function exchangeCodeForAccessToken(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  const u = new URL(FACEBOOK_TOKEN_URL);
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('client_secret', params.clientSecret);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('code', params.code);

  let res: Response;
  try {
    res = await fetch(u, { method: 'GET' });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  const accessToken = normalizeString((json as Record<string, unknown> | null)?.access_token);
  if (!accessToken) {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  return { accessToken };
}

async function fetchFacebookUserInfo(params: { accessToken: string }): Promise<unknown> {
  const u = new URL(FACEBOOK_ME_URL);
  u.searchParams.set('fields', 'id,name,email,picture.type(large)');
  u.searchParams.set('access_token', params.accessToken);

  let res: Response;
  try {
    res = await fetch(u, { method: 'GET' });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_USERINFO_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_USERINFO_FAILED');
  }

  try {
    return await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_USERINFO_FAILED');
  }
}

function extractPictureUrl(value: unknown): string | null {
  const obj = (value ?? {}) as Record<string, unknown>;
  const picture = obj.picture as Record<string, unknown> | null | undefined;
  const data = (picture?.data ?? null) as Record<string, unknown> | null;
  return normalizeOptionalString(data?.url);
}

export async function getFacebookProfileFromCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<SocialProfile> {
  const { accessToken } = await exchangeCodeForAccessToken({
    code: params.code,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    redirectUri: params.redirectUri,
  });

  const info = await fetchFacebookUserInfo({ accessToken });
  const obj = (info ?? {}) as Record<string, unknown>;

  const email = normalizeString(obj.email);
  if (!email) {
    // Email is the canonical identifier (brief section 2); fail closed if Facebook doesn't provide one.
    throw new AppError('UNAUTHORIZED', 401, 'FACEBOOK_EMAIL_MISSING');
  }

  return validateSocialProfile({
    provider: 'facebook',
    email,
    // Facebook doesn't provide an explicit email verification flag via the basic profile.
    // Treat the presence of an email on the authenticated user profile as provider-verified.
    emailVerified: true,
    name: normalizeOptionalString(obj.name),
    avatarUrl: extractPictureUrl(obj),
  });
}


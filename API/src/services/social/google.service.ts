import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

function parseBooleanish(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  if (typeof value === 'number') return value === 1;
  return false;
}

export function buildGoogleAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', params.state);
  // Keep minimal; no offline access, no refresh tokens.
  u.searchParams.set('access_type', 'online');
  return u.toString();
}

async function exchangeCodeForAccessToken(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams();
  body.set('code', params.code);
  body.set('client_id', params.clientId);
  body.set('client_secret', params.clientSecret);
  body.set('redirect_uri', params.redirectUri);
  body.set('grant_type', 'authorization_code');

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }

  const accessToken = normalizeString((json as Record<string, unknown> | null)?.access_token);
  if (!accessToken) {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_TOKEN_EXCHANGE_FAILED');
  }

  return { accessToken };
}

async function fetchGoogleUserInfo(params: { accessToken: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_USERINFO_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${params.accessToken}` },
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_USERINFO_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_USERINFO_FAILED');
  }

  try {
    return await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GOOGLE_USERINFO_FAILED');
  }
}

export async function getGoogleProfileFromCode(params: {
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

  const info = await fetchGoogleUserInfo({ accessToken });
  const obj = (info ?? {}) as Record<string, unknown>;

  return validateSocialProfile({
    provider: 'google',
    email: normalizeString(obj.email),
    // Brief 22.6: require provider-verified email. Some providers may serialize booleans as strings.
    emailVerified: parseBooleanish(obj.email_verified),
    name: normalizeOptionalString(obj.name),
    avatarUrl: normalizeOptionalString(obj.picture),
  });
}

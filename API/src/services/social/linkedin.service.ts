import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

// LinkedIn "Sign In with LinkedIn" (OIDC) endpoints.
const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

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

export function buildLinkedInAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(LINKEDIN_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  // Request only what we need: verified email + basic profile.
  // Keep minimal; no offline access, no refresh tokens.
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', params.state);
  return u.toString();
}

async function exchangeCodeForAccessToken(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('client_id', params.clientId);
  body.set('client_secret', params.clientSecret);
  body.set('redirect_uri', params.redirectUri);

  let res: Response;
  try {
    res = await fetch(LINKEDIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_TOKEN_EXCHANGE_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_TOKEN_EXCHANGE_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_TOKEN_EXCHANGE_FAILED');
  }

  const accessToken = normalizeString((json as Record<string, unknown> | null)?.access_token);
  if (!accessToken) {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_TOKEN_EXCHANGE_FAILED');
  }

  return { accessToken };
}

async function fetchLinkedInUserInfo(params: { accessToken: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(LINKEDIN_USERINFO_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${params.accessToken}` },
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_USERINFO_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_USERINFO_FAILED');
  }

  try {
    return await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_USERINFO_FAILED');
  }
}

function buildDisplayName(obj: Record<string, unknown>): string | null {
  const direct = normalizeOptionalString(obj.name);
  if (direct) return direct;

  const given = normalizeOptionalString(obj.given_name);
  const family = normalizeOptionalString(obj.family_name);
  const joined = [given, family].filter(Boolean).join(' ').trim();
  return joined ? joined : null;
}

export async function getLinkedInProfileFromCode(params: {
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

  const info = await fetchLinkedInUserInfo({ accessToken });
  const obj = (info ?? {}) as Record<string, unknown>;

  const email = normalizeString(obj.email);
  if (!email) {
    // Email is the canonical identifier (brief section 2); fail closed if LinkedIn doesn't provide one.
    throw new AppError('UNAUTHORIZED', 401, 'LINKEDIN_EMAIL_MISSING');
  }

  return validateSocialProfile({
    provider: 'linkedin',
    email,
    // Brief 22.6: require provider-verified email.
    // LinkedIn OIDC userinfo exposes `email_verified` when available.
    emailVerified: parseBooleanish(obj.email_verified),
    name: buildDisplayName(obj),
    avatarUrl: normalizeOptionalString(obj.picture),
  });
}


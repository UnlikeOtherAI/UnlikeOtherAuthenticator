import { AppError } from '../../utils/errors.js';
import { validateSocialProfile, type SocialProfile } from './provider.base.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  const s = normalizeString(value);
  return s ? s : null;
}

export function buildGitHubAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  // Request only what we need: user profile + verified email selection.
  u.searchParams.set('scope', 'read:user user:email');
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
  body.set('client_id', params.clientId);
  body.set('client_secret', params.clientSecret);
  body.set('code', params.code);
  body.set('redirect_uri', params.redirectUri);

  let res: Response;
  try {
    res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_TOKEN_EXCHANGE_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_TOKEN_EXCHANGE_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_TOKEN_EXCHANGE_FAILED');
  }

  const accessToken = normalizeString((json as Record<string, unknown> | null)?.access_token);
  if (!accessToken) {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_TOKEN_EXCHANGE_FAILED');
  }

  return { accessToken };
}

async function fetchGitHubUser(params: { accessToken: string }): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/user`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${params.accessToken}`,
        // Some deployments enforce a user-agent for API calls; include a stable one.
        'user-agent': 'uoa-auth-service',
      },
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_USERINFO_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_USERINFO_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_USERINFO_FAILED');
  }

  return (json ?? {}) as Record<string, unknown>;
}

type GitHubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
};

function parseGitHubEmails(value: unknown): GitHubEmail[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const obj = v as Record<string, unknown>;
      return {
        email: normalizeString(obj.email),
        primary: Boolean(obj.primary),
        verified: Boolean(obj.verified),
      };
    })
    .filter((e) => Boolean(e.email));
}

function selectVerifiedEmail(emails: GitHubEmail[]): string {
  // Brief 22.6: only provider-verified emails are accepted.
  const verified = emails.filter((e) => e.verified);
  const primary = verified.find((e) => e.primary);
  return (primary ?? verified[0])?.email ?? '';
}

async function fetchGitHubVerifiedEmail(params: { accessToken: string }): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/user/emails`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${params.accessToken}`,
        'user-agent': 'uoa-auth-service',
      },
    });
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_EMAILS_FAILED');
  }

  if (!res.ok) {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_EMAILS_FAILED');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_EMAILS_FAILED');
  }

  const email = selectVerifiedEmail(parseGitHubEmails(json));
  if (!email) {
    throw new AppError('UNAUTHORIZED', 401, 'GITHUB_EMAIL_NOT_VERIFIED');
  }

  return email;
}

export async function getGitHubProfileFromCode(params: {
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

  const user = await fetchGitHubUser({ accessToken });
  const email = await fetchGitHubVerifiedEmail({ accessToken });

  const name = normalizeOptionalString(user.name) ?? normalizeOptionalString(user.login);

  return validateSocialProfile({
    provider: 'github',
    email,
    emailVerified: true,
    name,
    avatarUrl: normalizeOptionalString(user.avatar_url),
  });
}


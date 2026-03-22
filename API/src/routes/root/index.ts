import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { registerLlmRoute } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = 'unknown';
try {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
  ) as { version: string };
  version = pkg.version;
} catch {
  // Fallback if package.json is not co-located (e.g. Docker image without it).
}

type EndpointSchema = {
  method: string;
  path: string;
  description: string;
  auth?: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  response?: Record<string, string>;
};

const endpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/',
    description: 'API information and full endpoint schema',
  },
  {
    method: 'GET',
    path: '/llm',
    description: 'LLM-friendly configuration and integration guide',
  },
  { method: 'GET', path: '/health', description: 'Health check' },
  {
    method: 'GET',
    path: '/auth',
    description: 'OAuth entrypoint — renders the auth UI',
    query: {
      config_url: 'string (required) — URL to fetch signed config JWT',
      redirect_url: 'string (optional) — OAuth redirect URL override (redirect_uri also accepted)',
    },
  },
  {
    method: 'POST',
    path: '/auth/login',
    description: 'Email/password login',
    auth: 'config_url query param',
    query: { redirect_url: 'string (optional, redirect_uri also accepted)' },
    body: {
      email: 'string (required)',
      password: 'string (required)',
      remember_me: 'boolean (optional) — defaults to session.remember_me_default from config',
    },
    response: {
      ok: 'true',
      code: 'authorization code',
      redirect_to: 'full redirect URL with code',
      twofa_required: 'true (only if 2FA needed)',
      twofa_token: 'challenge token (only if 2FA needed)',
    },
  },
  {
    method: 'POST',
    path: '/auth/register',
    description: 'User registration — sends verification email',
    auth: 'config_url query param',
    body: { email: 'string (required)' },
    response: { message: '"We sent instructions to your email" (always, no enumeration)' },
  },
  {
    method: 'POST',
    path: '/auth/verify-email',
    description: 'Complete email verification (registration)',
    auth: 'config_url query param',
    query: { redirect_url: 'string (optional)' },
    body: {
      token: 'string (required) — email verification token',
      password: 'string (optional) — required for password_required registration mode',
    },
    response: { ok: 'true', code: 'authorization code', redirect_to: 'redirect URL' },
  },
  {
    method: 'POST',
    path: '/auth/token',
    description: 'Exchange authorization code or refresh token for access + refresh tokens',
    auth: 'config_url query param + domain hash bearer token',
    body: {
      'grant_type?': '"authorization_code" (default) or "refresh_token"',
      'code?': 'authorization code (for authorization_code grant)',
      'refresh_token?': 'refresh token (for refresh_token grant)',
    },
    response: {
      access_token: 'JWT',
      expires_in: 'seconds',
      refresh_token: 'opaque token',
      refresh_token_expires_in: 'seconds',
      token_type: '"Bearer"',
    },
  },
  {
    method: 'POST',
    path: '/auth/revoke',
    description: 'Revoke refresh token family (logout)',
    auth: 'config_url query param + domain hash bearer token',
    body: { refresh_token: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/auth/reset-password/request',
    description: 'Initiate password reset (no enumeration)',
    auth: 'config_url query param',
    body: { email: 'string (required)' },
    response: { message: '"We sent instructions to your email" (always)' },
  },
  {
    method: 'POST',
    path: '/auth/reset-password',
    description: 'Complete password reset with token',
    auth: 'config_url query param',
    body: { token: 'string (required)', password: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/auth/email/reset-password',
    description: 'Email link landing — renders set-password UI',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/auth/email/twofa-reset',
    description: 'Email link landing for 2FA reset',
    query: { token: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/auth/email/link',
    description: 'Email registration/login link landing',
    query: { token: 'string (required)', redirect_url: 'string (optional)' },
  },
  {
    method: 'GET',
    path: '/auth/social/:provider',
    description: 'Initiate social OAuth flow (google, facebook, github, linkedin, apple)',
    query: { config_url: 'string (required)', redirect_url: 'string (optional)' },
  },
  {
    method: 'GET',
    path: '/auth/callback/:provider',
    description: 'OAuth provider callback (server-to-server)',
  },
  {
    method: 'GET',
    path: '/auth/domain-mapping',
    description: 'Look up org/team mapping for an email domain',
    auth: 'config_url query param + domain hash bearer token',
    query: { email_domain: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/2fa/verify',
    description: 'Verify TOTP 2FA code during login',
    auth: 'config_url query param',
    body: { twofa_token: 'string (required)', code: 'string (required) — 6-digit TOTP' },
    response: { ok: 'true', code: 'authorization code', redirect_to: 'redirect URL' },
  },
  {
    method: 'POST',
    path: '/2fa/reset/request',
    description: 'Initiate 2FA reset via email',
    auth: 'config_url query param',
    body: { email: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/2fa/reset',
    description: 'Complete 2FA reset with email token',
    auth: 'config_url query param',
    body: { token: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/i18n/get',
    description: 'Fetch translation data for a language',
    query: { lang: 'string (required)', config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/domain/users',
    description: 'List users for a domain',
    auth: 'domain hash bearer token',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/domain/logs',
    description: 'Login logs for a domain',
    auth: 'domain hash bearer token',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/domain/debug',
    description: 'Debug info (requires debug_enabled in config)',
    auth: 'domain hash bearer token',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/me',
    description: 'Current user org context',
    auth: 'access token (X-UOA-Access-Token header)',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations',
    description: 'List organisations for domain',
    auth: 'domain hash bearer token',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/org/organisations',
    description: 'Create organisation',
    auth: 'domain hash bearer token',
    body: { name: 'string (required)', owner_id: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId',
    description: 'Get organisation details',
    auth: 'domain hash bearer token',
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId',
    description: 'Update organisation',
    auth: 'domain hash bearer token',
    body: { name: 'string (optional)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId',
    description: 'Delete organisation',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/members',
    description: 'List organisation members',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members',
    description: 'Add organisation member',
    auth: 'domain hash bearer token',
    body: { user_id: 'string (required)', role: 'string (optional)' },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/members/:userId',
    description: 'Change member role',
    auth: 'domain hash bearer token',
    body: { role: 'string (required)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/members/:userId',
    description: 'Remove organisation member',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/ownership-transfer',
    description: 'Transfer organisation ownership',
    auth: 'domain hash bearer token',
    body: { new_owner_id: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams',
    description: 'List teams',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams',
    description: 'Create team',
    auth: 'domain hash bearer token',
    body: { name: 'string (required)', description: 'string (optional)' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Get team details (includes members)',
    auth: 'domain hash bearer token',
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Update team',
    auth: 'domain hash bearer token',
    body: { name: 'string (optional)', description: 'string (optional)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Delete team',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/members',
    description: 'Add team member',
    auth: 'domain hash bearer token',
    body: { user_id: 'string (required)', team_role: 'string (optional)' },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description: 'Change team member role',
    auth: 'domain hash bearer token',
    body: { team_role: 'string (required)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description: 'Remove team member',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups',
    description: 'List groups',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups/:groupId',
    description: 'Get group details',
    auth: 'domain hash bearer token',
  },
];

export function registerRootRoute(app: FastifyInstance): void {
  registerLlmRoute(app);

  app.get('/', async () => {
    return {
      name: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service used by multiple products.',
      version,
      repository: 'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
      docs: '/llm',
      endpoints,
    };
  });
}

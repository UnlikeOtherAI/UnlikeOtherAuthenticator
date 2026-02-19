import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

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

export function registerRootRoute(app: FastifyInstance): void {
  app.get('/', async () => {
    return {
      name: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service used by multiple products.',
      version,
      repository: 'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
      endpoints: [
        { method: 'GET', path: '/', description: 'API information (this endpoint)' },
        { method: 'GET', path: '/health', description: 'Health check' },
        { method: 'GET', path: '/auth', description: 'OAuth entrypoint' },
        { method: 'POST', path: '/auth/login', description: 'Email/password login' },
        { method: 'POST', path: '/auth/register', description: 'User registration' },
        { method: 'POST', path: '/auth/verify-email', description: 'Email verification' },
        {
          method: 'POST',
          path: '/auth/token-exchange',
          description: 'Exchange auth code for access token',
        },
        {
          method: 'POST',
          path: '/auth/reset-password/request',
          description: 'Initiate password reset',
        },
        {
          method: 'POST',
          path: '/auth/reset-password',
          description: 'Complete password reset with token',
        },
        {
          method: 'GET',
          path: '/auth/email/reset-password',
          description: 'Email link landing for password reset',
        },
        {
          method: 'GET',
          path: '/auth/email/twofa-reset',
          description: 'Email link landing for 2FA reset',
        },
        {
          method: 'GET',
          path: '/auth/email/link',
          description: 'Email registration link landing',
        },
        {
          method: 'GET',
          path: '/auth/social/:provider',
          description: 'Social OAuth initiation',
        },
        {
          method: 'GET',
          path: '/auth/callback/:provider',
          description: 'OAuth provider callback',
        },
        { method: 'POST', path: '/2fa/verify', description: 'Verify 2FA code' },
        {
          method: 'POST',
          path: '/2fa/reset/request',
          description: 'Initiate 2FA reset',
        },
        {
          method: 'POST',
          path: '/2fa/reset',
          description: 'Complete 2FA reset with token',
        },
        { method: 'GET', path: '/i18n/get', description: 'Fetch translation data' },
        {
          method: 'GET',
          path: '/domain/users',
          description: 'List domain users (domain auth required)',
        },
        {
          method: 'GET',
          path: '/domain/logs',
          description: 'Domain login logs (domain auth required)',
        },
        {
          method: 'GET',
          path: '/domain/debug',
          description: 'Domain debug info (domain auth required)',
        },
        {
          method: 'GET',
          path: '/org/me',
          description: 'Current user org context (access token required)',
        },
        {
          method: 'GET',
          path: '/org/organisations',
          description: 'List organisations for domain',
        },
        { method: 'POST', path: '/org/organisations', description: 'Create organisation' },
        {
          method: 'GET',
          path: '/org/organisations/:orgId',
          description: 'Get organisation details',
        },
        {
          method: 'PUT',
          path: '/org/organisations/:orgId',
          description: 'Update organisation',
        },
        {
          method: 'DELETE',
          path: '/org/organisations/:orgId',
          description: 'Delete organisation',
        },
        {
          method: 'GET',
          path: '/org/organisations/:orgId/members',
          description: 'List organisation members',
        },
        {
          method: 'POST',
          path: '/org/organisations/:orgId/members',
          description: 'Add organisation member',
        },
        {
          method: 'PUT',
          path: '/org/organisations/:orgId/members/:userId',
          description: 'Change member role',
        },
        {
          method: 'DELETE',
          path: '/org/organisations/:orgId/members/:userId',
          description: 'Remove organisation member',
        },
        {
          method: 'POST',
          path: '/org/organisations/:orgId/ownership-transfer',
          description: 'Transfer organisation ownership',
        },
        {
          method: 'GET',
          path: '/org/organisations/:orgId/teams',
          description: 'List teams',
        },
        {
          method: 'POST',
          path: '/org/organisations/:orgId/teams',
          description: 'Create team',
        },
        {
          method: 'GET',
          path: '/org/organisations/:orgId/teams/:teamId',
          description: 'Get team details (includes members)',
        },
        {
          method: 'PUT',
          path: '/org/organisations/:orgId/teams/:teamId',
          description: 'Update team',
        },
        {
          method: 'DELETE',
          path: '/org/organisations/:orgId/teams/:teamId',
          description: 'Delete team',
        },
        {
          method: 'POST',
          path: '/org/organisations/:orgId/teams/:teamId/members',
          description: 'Add team member',
        },
        {
          method: 'PUT',
          path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
          description: 'Change team member role',
        },
        {
          method: 'DELETE',
          path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
          description: 'Remove team member',
        },
        {
          method: 'GET',
          path: '/org/organisations/:orgId/groups',
          description: 'List groups',
        },
        {
          method: 'GET',
          path: '/org/organisations/:orgId/groups/:groupId',
          description: 'Get group details',
        },
      ],
    };
  });
}

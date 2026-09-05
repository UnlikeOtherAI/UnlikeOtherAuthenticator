import type { FastifyInstance } from 'fastify';

import { registerDomainDebugRoute } from './debug.js';
import { registerDomainLogsRoute } from './logs.js';
import { registerDomainTeamAvatarRoutes } from './team-avatar.js';
import { registerDomainTeamHostnameRoutes } from './team-hostnames.js';
import { registerDomainUserAvatarRoutes } from './user-avatar.js';
import { registerDomainUsersRoute } from './users.js';
import { registerDomainSignatureRoutes } from './signatures.js';

export function registerDomainRoutes(app: FastifyInstance): void {
  registerDomainDebugRoute(app);
  registerDomainLogsRoute(app);
  registerDomainUsersRoute(app);
  registerDomainUserAvatarRoutes(app);
  registerDomainTeamAvatarRoutes(app);
  registerDomainTeamHostnameRoutes(app);
  registerDomainSignatureRoutes(app);
}

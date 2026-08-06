import type { FastifyInstance } from 'fastify';

import { registerAvatarMeRoutes } from './me.js';
import { registerPublicTeamAvatarRoute } from './public-team.js';

export function registerAvatarRoutes(app: FastifyInstance): void {
  registerAvatarMeRoutes(app);
  registerPublicTeamAvatarRoute(app);
}

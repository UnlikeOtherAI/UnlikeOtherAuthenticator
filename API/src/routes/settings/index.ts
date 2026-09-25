import type { FastifyInstance } from 'fastify';

import { registerUserSettingsMeRoutes } from './me.js';

export function registerSettingsRoutes(app: FastifyInstance): void {
  registerUserSettingsMeRoutes(app);
}

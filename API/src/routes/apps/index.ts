import { registerTelephoneProfileRoutes } from './telephone-profile.js';
import type { FastifyInstance } from 'fastify';

import { registerAppFlagRoutes } from './flags.js';
import { registerAppStartupRoute } from './startup.js';
import { registerDeepTestNessieInferenceAccessRoute } from './deeptest-nessie-inference-access.js';

export function registerAppRoutes(app: FastifyInstance): void {
  registerTelephoneProfileRoutes(app);
  registerAppStartupRoute(app);
  registerAppFlagRoutes(app);
  registerDeepTestNessieInferenceAccessRoute(app);
}

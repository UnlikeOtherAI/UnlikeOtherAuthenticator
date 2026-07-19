import type { FastifyInstance } from 'fastify';

import { buildPublicErrorBody } from '../utils/error-response.js';
import { registerAdminUiRoutes } from './admin-ui.js';
import { registerAppRoutes } from './apps/index.js';
import { registerAuthRoutes } from './auth/index.js';
import { registerBillingRoutes } from './billing/index.js';
import { registerConfigJwksRoute } from './config-jwks.js';
import { registerDomainRoutes } from './domain/index.js';
import { registerEmailRoutes } from './email/index.js';
import { registerInternalAdminRoutes } from './internal/admin/index.js';
import { registerInternalOrgRoutes } from './internal/org/index.js';
import { registerHealthRoutes } from './health/index.js';
import { registerI18nRoutes } from './i18n/index.js';
import { registerIntegrationRoutes } from './integrations/index.js';
import { registerOAuthRoutes } from './oauth/index.js';
import { registerOrgRoutes } from './org/index.js';
import { registerRootRoute } from './root/index.js';
import { registerSignatureRoutes } from './signatures/index.js';
import { registerTwoFactorRoutes } from './twofactor/index.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerRootRoute(app);
  registerSignatureRoutes(app);
  registerConfigJwksRoute(app);
  registerHealthRoutes(app);
  registerAdminUiRoutes(app);
  registerAppRoutes(app);
  registerAuthRoutes(app);
  registerBillingRoutes(app);
  registerDomainRoutes(app);
  registerEmailRoutes(app);
  registerIntegrationRoutes(app);
  registerOAuthRoutes(app);
  registerInternalAdminRoutes(app);
  registerInternalOrgRoutes(app);
  registerOrgRoutes(app);
  registerI18nRoutes(app);
  registerTwoFactorRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
  });
}

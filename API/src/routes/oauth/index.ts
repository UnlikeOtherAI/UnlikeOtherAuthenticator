import type { FastifyInstance } from 'fastify';

import { registerOAuthAccountRoutes } from './account.js';
import { registerOAuthAuthorizeRoute } from './authorize.js';
import { registerOAuthJwksRoute } from './jwks.js';
import { registerOAuthLoginRoute } from './login.js';
import { registerOAuthMetadataRoute } from './metadata.js';
import { registerOAuthRegisterRoute } from './register.js';
import { registerOAuthTokenRoute } from './token.js';

// Public-client / MCP OAuth profile (brief §22.14).
export function registerOAuthRoutes(app: FastifyInstance): void {
  registerOAuthAccountRoutes(app);
  registerOAuthMetadataRoute(app);
  registerOAuthJwksRoute(app);
  registerOAuthRegisterRoute(app);
  registerOAuthAuthorizeRoute(app);
  registerOAuthLoginRoute(app);
  registerOAuthTokenRoute(app);
}

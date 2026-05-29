import type { FastifyInstance } from 'fastify';

import { registerOAuthJwksRoute } from './jwks.js';
import { registerOAuthMetadataRoute } from './metadata.js';
import { registerOAuthRegisterRoute } from './register.js';

// Public-client / MCP OAuth profile (brief §22.14). The interactive
// authorize/login/token routes are registered here as they land.
export function registerOAuthRoutes(app: FastifyInstance): void {
  registerOAuthMetadataRoute(app);
  registerOAuthJwksRoute(app);
  registerOAuthRegisterRoute(app);
}

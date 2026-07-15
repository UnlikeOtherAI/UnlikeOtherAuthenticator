import type { FastifyInstance } from 'fastify';

import { registerSignatureSessionRoutes } from './session.js';
import { registerSignatureMeRoutes } from './me.js';
import { registerSignatureVerificationRoute } from './verify.js';

export function registerSignatureRoutes(app: FastifyInstance): void {
  registerSignatureSessionRoutes(app);
  registerSignatureMeRoutes(app);
  registerSignatureVerificationRoute(app);
}

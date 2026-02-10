import type { FastifyInstance } from 'fastify';

import { registerAuthEntrypointRoute } from './entrypoint.js';
import { registerAuthEmailVerifySetPasswordRoute } from './email-verify-set-password.js';
import { registerAuthLoginRoute } from './login.js';
import { registerAuthRegisterRoute } from './register.js';
import { registerAuthVerifyEmailRoute } from './verify-email.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
  registerAuthEmailVerifySetPasswordRoute(app);
  registerAuthLoginRoute(app);
  registerAuthRegisterRoute(app);
  registerAuthVerifyEmailRoute(app);
}

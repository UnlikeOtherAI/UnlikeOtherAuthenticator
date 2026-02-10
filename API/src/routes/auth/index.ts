import type { FastifyInstance } from 'fastify';

import { registerAuthEmailResetPasswordRoute } from './email-reset-password.js';
import { registerAuthEntrypointRoute } from './entrypoint.js';
import { registerAuthEmailVerifySetPasswordRoute } from './email-verify-set-password.js';
import { registerAuthLoginRoute } from './login.js';
import { registerAuthRegisterRoute } from './register.js';
import { registerAuthResetPasswordRoutes } from './reset-password.js';
import { registerAuthVerifyEmailRoute } from './verify-email.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
  registerAuthEmailResetPasswordRoute(app);
  registerAuthEmailVerifySetPasswordRoute(app);
  registerAuthLoginRoute(app);
  registerAuthRegisterRoute(app);
  registerAuthResetPasswordRoutes(app);
  registerAuthVerifyEmailRoute(app);
}

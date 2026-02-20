import type { FastifyInstance } from 'fastify';

import { registerAuthEmailResetPasswordRoute } from './email-reset-password.js';
import { registerAuthEmailRegistrationLinkRoute } from './email-registration-link.js';
import { registerAuthEmailTwoFaResetRoute } from './email-twofa-reset.js';
import { registerAuthEntrypointRoute } from './entrypoint.js';
import { registerAuthLoginRoute } from './login.js';
import { registerAuthDomainMappingRoute } from './domain-mapping.js';
import { registerAuthRegisterRoute } from './register.js';
import { registerAuthResetPasswordRoutes } from './reset-password.js';
import { registerAuthTokenExchangeRoute } from './token-exchange.js';
import { registerAuthVerifyEmailRoute } from './verify-email.js';
import { registerAuthSocialRoute } from './social.js';
import { registerAuthCallbackRoute } from './callback.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
  registerAuthCallbackRoute(app);
  registerAuthEmailResetPasswordRoute(app);
  registerAuthEmailTwoFaResetRoute(app);
  registerAuthEmailRegistrationLinkRoute(app);
  registerAuthLoginRoute(app);
  registerAuthDomainMappingRoute(app);
  registerAuthRegisterRoute(app);
  registerAuthResetPasswordRoutes(app);
  registerAuthSocialRoute(app);
  registerAuthTokenExchangeRoute(app);
  registerAuthVerifyEmailRoute(app);
}

import type { FastifyInstance } from 'fastify';

import { registerAuthEmailResetPasswordRoute } from './email-reset-password.js';
import { registerAuthEmailRegistrationLinkRoute } from './email-registration-link.js';
import { registerAuthEmailTeamInviteRoute } from './email-team-invite.js';
import { registerAuthEmailTeamInviteOpenRoute } from './email-team-invite-open.js';
import { registerAuthEmailTwoFaResetRoute } from './email-twofa-reset.js';
import { registerAuthEntrypointRoute } from './entrypoint.js';
import { registerAuthLoginRoute } from './login.js';
import { registerAuthDomainMappingRoute } from './domain-mapping.js';
import { registerAuthRevokeRoute } from './revoke.js';
import { registerAuthRegisterRoute } from './register.js';
import { registerAuthResetPasswordRoutes } from './reset-password.js';
import { registerAuthSelectTeamRoute } from './auth-select-team.js';
import { registerAuthStartRoute } from './auth-start.js';
import { registerAuthTeamInviteLinkRoute } from './team-invite-link.js';
import { registerAuthTokenExchangeRoute } from './token-exchange.js';
import { registerAuthVerifyCodeRoute } from './auth-verify-code.js';
import { registerAuthVerifyEmailRoute } from './verify-email.js';
import { registerAuthSocialRoute } from './social.js';
import { registerAuthCallbackRoute } from './callback.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  registerAuthEntrypointRoute(app);
  registerAuthCallbackRoute(app);
  registerAuthEmailResetPasswordRoute(app);
  registerAuthEmailTwoFaResetRoute(app);
  registerAuthEmailRegistrationLinkRoute(app);
  registerAuthEmailTeamInviteRoute(app);
  registerAuthEmailTeamInviteOpenRoute(app);
  registerAuthLoginRoute(app);
  registerAuthDomainMappingRoute(app);
  registerAuthRegisterRoute(app);
  registerAuthResetPasswordRoutes(app);
  registerAuthSelectTeamRoute(app);
  registerAuthSocialRoute(app);
  registerAuthStartRoute(app);
  registerAuthTeamInviteLinkRoute(app);
  registerAuthRevokeRoute(app);
  registerAuthTokenExchangeRoute(app);
  registerAuthVerifyCodeRoute(app);
  registerAuthVerifyEmailRoute(app);
}

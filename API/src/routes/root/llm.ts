import type { FastifyInstance } from 'fastify';
import { llmNativeAppsMarkdown } from './llm-native-apps.js';
import { llmWebsiteServicesMarkdown } from './llm-website-services.js';

import { llmAvatarsMarkdown } from './llm-avatars.js';
import { llmBillingMarkdown } from './llm-billing.js';
import { llmIntegrationMarkdown } from './llm-integration.js';
import { llmIntegrationMarkdown2 } from './llm-integration-2.js';
import { llmRostersMarkdown } from './llm-integration-rosters.js';
import { llmIntroMarkdown } from './llm-intro.js';
import { llmSettingsMarkdown } from './llm-settings.js';
import { llmSignaturesMarkdown } from './llm-signatures.js';

function renderLlmMarkdown(): string {
  // llmIntegrationMarkdown owns both confidential subject profiles: one-time
  // source assertions and reusable, audience-bound chained access tokens. llmRostersMarkdown
  // owns the exact-team invitation management and role-write contracts.
  return `${llmIntroMarkdown}\n## One-use debug login\nPOST /auth/debug-login/issue?config_url=... with the domain bearer and {refresh_token, previous_token?} returns {token, expires_in:1800}. Renew invalidates the previous code atomically. POST /auth/debug-login/redeem with the same verified config_url and bearer plus {token} consumes the code and returns an independent ordinary token pair. Codes bind the exact product/environment, source family, credential epoch and selected team. Expiry, logout, revocation or loss of membership refuse redemption. Tokens must stay in POST bodies; the product owns the bottom-right issue/redeem UI and exports exactly {url,token}.\n${llmWebsiteServicesMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmRostersMarkdown}\n${llmBillingMarkdown}\n${llmSignaturesMarkdown}\n${llmAvatarsMarkdown}\n${llmSettingsMarkdown}\n${llmNativeAppsMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

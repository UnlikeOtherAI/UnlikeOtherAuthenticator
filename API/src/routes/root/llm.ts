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
  return `${llmIntroMarkdown}\n## Admin team membership\nPOST /internal/admin/users/:userId/teams accepts {orgId, teamId, teamRole: "member" | "admin"} with an admin-domain superuser bearer. It atomically adds missing organisation/default-team membership as member and the requested team role, using standard UOA membership limits. Exact retries are idempotent; active roles are never changed by Add. Removed memberships can be re-added with the requested role, without reviving revoked sessions. Suspended memberships and ownership changes are refused. All writes and audit records commit together.\n\n## One-use debug login\nPOST /auth/debug-login/issue?config_url=... with the domain bearer and {refresh_token, previous_token?} returns {token, expires_in:1800}. Renew invalidates the previous code atomically. POST /auth/debug-login/redeem with the same verified config_url and bearer plus {token} consumes the code and returns an independent ordinary token pair. Codes bind the exact product/environment, source family, credential epoch and selected team. Expiry, logout, revocation or loss of membership refuse redemption. Normal session logout calls POST /auth/revoke with {refresh_token,scope:"family"}; it revokes only that family and its unused debug grants. Omitting scope retains global credential epoch revocation. Tokens must stay in POST bodies; the product owns the bottom-right issue/redeem UI and exports exactly {url,token}.\n## Selkie broker capability\nThe existing confidential exchange accepts session:broker only for product coder, source coder.unlikeotherai.com and exact resource https://api.selkie.live, with an explicit enabled operator mapping. Active org/team and credential epoch are required. Chained exchange is refused. POST /auth/session-broker/validate?config_url=<Selkie signed config> with Selkie domain bearer and {token} rechecks signature, exact audience/scope/source, current mapping, credential epoch, source domain role and active team. Response {sub,expires_at,active:{orgId,teamId}} contains no profiles. Selkie validates each broker request and caps its opaque local handle at the capability expiry; rebroker after expiry. Broker capabilities cannot issue debug login grants or independent refresh families.\n${llmWebsiteServicesMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmRostersMarkdown}\n${llmBillingMarkdown}\n${llmSignaturesMarkdown}\n${llmAvatarsMarkdown}\n${llmSettingsMarkdown}\n${llmNativeAppsMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

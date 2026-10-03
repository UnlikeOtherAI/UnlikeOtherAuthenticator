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
  return `## Entity access and deletion (2026-10-03)
Lifecycle ACTIVE/DISABLED/DELETING/DELETED is distinct from membership. Parent disable denies descendant access without changing child state; no superuser bypass. Offline products must introspect or bound JWT expiry to honor revocation. See /api lifecycle and endpoint schemas. Admin templates have scoped plain customer text and revision snapshots; internal notes never reach account-status proof. POST /auth/lifecycle-status/start and verify use signed config_url, mailbox code and enrolled TOTP solely to read authorized reasons, never to log in. Native clients use /oauth/lifecycle-status/start and verify with registered client_id and exact redirect_uri; current app revision binds the proof.
Platform-admin lifecycle endpoints provide preview, typed confirmation, durable jobs and progress. RETAIN_REFERENCE removes PII/credentials and exposes history as {id,deleted:true,name:"Deleted user"} via authorized /domain/historical-users/:id. ERASE_REFERENCE erases mutable identity references; immutable financial/signing evidence may retain restricted IDs/stubs, explicitly inventoried. Ownership must transfer first for retained organisations. Last-team deletion includes the now-empty organisation; shared/dependent accounts survive. Active collection/capabilities must close or transfer before confirmation. Old direct organisation/team DELETE routes now return 409 ENTITY_DELETION_WORKFLOW_REQUIRED.
Products authenticate their exact registered domain bearer to GET /domain/deletion-jobs?domain=... and POST /domain/deletion-jobs/:id/acknowledge?domain=... with {revision,outcome:"PURGED"|"RETAINED_EVIDENCE"}. Honor effectiveScope/effectiveTargetId, teamIds and committed accountsToDelete; replies acknowledge committed cleanup, never merely receipt. Keep only UOA references and product-owned data. Pending or unknown product inventory blocks completion; this repository does not deploy other product adapters. The pull response is {data:[jobs]}. Retained-evidence acknowledgements may include up to30 {label,count,reason} summaries, without unrelated PII; missing summaries are shown as details unavailable. The credential is rechecked under the product policy lock at acknowledgement. Admin retries finish bounded leased UOA cleanup stages only after all acknowledgements; READY after a retry means more stages remain.
${llmIntroMarkdown}\n## One-use debug login\nPOST /auth/debug-login/issue?config_url=... with the domain bearer and {refresh_token, previous_token?} returns {token, expires_in:1800}. Renew invalidates the previous code atomically. POST /auth/debug-login/redeem with the same verified config_url and bearer plus {token} consumes the code and returns an independent ordinary token pair. Codes bind the exact product/environment, source family, credential epoch and selected team. Expiry, logout, revocation or loss of membership refuse redemption. Normal session logout calls POST /auth/revoke with {refresh_token,scope:"family"}; it revokes only that family and its unused debug grants. Omitting scope retains global credential epoch revocation. Tokens must stay in POST bodies; the product owns the bottom-right issue/redeem UI and exports exactly {url,token}.\n${llmWebsiteServicesMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmRostersMarkdown}\n${llmBillingMarkdown}\n${llmSignaturesMarkdown}\n${llmAvatarsMarkdown}\n${llmSettingsMarkdown}\n${llmNativeAppsMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}

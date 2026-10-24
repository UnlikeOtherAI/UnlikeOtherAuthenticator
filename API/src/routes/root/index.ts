// Directory webhook consumption and exact-team avatar reads are documented in /llm and schema.ts.
import { lifecycleDocumentation } from './schema.lifecycle.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import {
  accessTokenDocumentation,
  confidentialTokenExchangeDocumentation,
  configJwtDocumentation,
  configValidationEndpointDocumentation,
  configVerificationEndpointDocumentation,
  teamSwitchDocumentation,
} from './config-docs.js';
import { registerConfigValidateRoute } from './config-validate.js';
import { registerConfigVerifyRoute } from './config-verify.js';
import { registerLlmRoute } from './llm.js';
import { endpoints } from './schema.js';
import { registrationVerificationDocumentation } from './schema.registration.js';
// Email-link approval continues only the original cookie-bound registration.
// Admin schema includes exact-user activity filters and canonical invitation history states.
import { readAdminIndexAssetUrls } from '../../services/admin-ui.service.js';
import { renderRootHoldingPage } from '../../services/root-page.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')) as {
    version: string;
  };
  version = pkg.version;
} catch {
  // Fallback if package.json is not co-located (e.g. Docker image without it).
}

export function registerRootRoute(app: FastifyInstance): void {
  registerLlmRoute(app);
  registerConfigValidateRoute(app);
  registerConfigVerifyRoute(app);

  app.get('/', async (_request, reply) => {
    const assets = await readAdminIndexAssetUrls();
    reply.header('Cache-Control', 'no-store, no-cache');
    reply.header('Pragma', 'no-cache');
    reply.type('text/html; charset=utf-8').send(renderRootHoldingPage(assets));
  });

  app.get('/api', async () => {
    return {
      name: 'UnlikeOtherAuthenticator',
      description:
        'Centralized OAuth and authentication service used by multiple products, including one-time first-hop assertions, audience-bound chained confidential exchange, and paged organisation membership rosters.',
      version,
      repository: 'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
      home: '/',
      docs: '/llm',
      api: '/api',
      organization_sign_in: { config: 'login_flow.organization_id', description: 'Optional exact UOA organization for hosted sign-in choices and completion; no membership grant. Omit for all eligible organizations.' },
      registration_verification: registrationVerificationDocumentation,
      personal_telephone: { profile: '/apps/v1/nessie/phone-profile/read', lookup: '/apps/v1/nessie/phone-profile/lookup',
        call_proof: '/apps/v1/nessie/phone-profile/call-proof/start',
        sms_admission: '/apps/v1/nessie/phone-profile/sms-admission',
        personal_owner_membership: 'optional owner_subject in service assertion; exact-team ownerActive or owner_inactive',
        prepaid_delivery: '/apps/v1/nessie/phone-profile/call-proof/reserve', caller_id_authentication: false },
      native_apps: { admin: '/admin/apps', registration: '/oauth/register', public_identifier: 'app_id', client_secret_required: false },
      enterprise_sso: { version: 1, settings: '/auth/organisation-access',
        entry: '/sso/:connectionId/start', domain_discovery: false,
        fresh_independent_proof: 'New completed independent authorization issues original confidential proof before minimum-floor enrollment; legacy refresh never fabricates proof. Explicit encrypted custody is required; SSO/recovery activation gates remain.',
        proof_bound_team_switch: 'Validate original source and current target policy, then return non-consuming 403 INTERACTION_REQUIRED before rotation. Normal target-bound authorization creates a separate exact-target family/proof; original holders and deadlines remain unchanged.',
        status: '/org/organisations/:orgId/sso/status', assurance: '/org/assurance/validate', assurance_scope: 'exact original organisation/team or null-scope independent proof',
        revocations: '/domain/revocations', activation: 'Fail closed until authority, provenance, consumer and protocol readiness pass; enforcement also requires two independent custodians and a completed recovery drill.' },
      deeptest_nessie_inference: { check: '/apps/v1/deeptest/nessie-inference-access',
        admin: '/internal/admin/users/:userId/deeptest-nessie-inference',
        default_allowed: false, positive_cache_allowed: false },
      kelpie_connect: { issue: '/oauth/kelpie/connect', validate: '/oauth/kelpie/connect/validate', scope: 'kelpie.connect', app_id: 'com.unlikeotherai.kelpie', ticket_ttl_seconds: 120, configuration: 'KELPIE_CONNECT_RESOURCE; exact HTTPS /api/kelpie/connect gateway, absent disables' },
      kelpie_pair: { issue: '/oauth/kelpie/pair', validate: '/oauth/kelpie/pair/validate', scope: 'kelpie.connect', receiver_scope: 'profile', ticket_ttl_seconds: 120, same_subject_required: true },
      admin_team_membership: 'POST /internal/admin/users/:userId/teams atomically adds an existing user to the selected organisation/team through the admin superuser boundary; see endpoints for its request and lifecycle rules.',
      ledger_runtime_keys: 'Admin Billing > selected product > Ledger runtime keys; existing platform-superuser metadata/issue/revoke API, one-time plaintext only, no installation or bootstrap authority.',
      sms_pricing: 'UOA owns final mobile-number and SMS quotes at /billing/v1/sms/quotes and /verify. Provider configuration and accepted dated currency policy are required; customer payloads contain final prices only.',
      sms_policy_operators: 'Admin Billing > SMS policies provides fixed-source ECB refresh/XML import, dimensional route evidence review and immutable acceptance. Current platform SUPERUSER only; five-minute operator/epoch-bound previews, private/no-store. SMS runtime credentials are issued under the selected product App keys with purpose sms_runtime.',
      config_jwt: configJwtDocumentation,
      website_service_identity: 'Separate subfolder services use config.domain=hostname/mount-path (no trailing slash). Register each complete identity independently; credentials, signing keys, roles, allowlists and organisation origin scope never inherit from its parent hostname.',
      access_token: accessTokenDocumentation,
      team_switch: teamSwitchDocumentation,
      confidential_token_exchange: confidentialTokenExchangeDocumentation,
      config_validation: configValidationEndpointDocumentation,
      config_verification: configVerificationEndpointDocumentation,
      endpoints,
      customer_invoices: 'Actual prepaid payment and monthly service charge invoices use the /billing/v1/invoices/* endpoints; their canonical JSON Schema and examples are at /schemas/billing-customer-invoices-v1.json.',
      lifecycle: lifecycleDocumentation,
      tenant_addresses: 'Hostname and id-to-address reads use the server-owned product team policy. Recognized products resolve unique active organisation labels across founding domains; ordinary clients remain domain-scoped. Ambiguous labels have no address. Resolution never grants access.',
      organisation_address_admission: 'New and changed organisation labels are globally unique across founding domains, enforced atomically in UOA. Existing ambiguous labels stay blocked without changing their owners. Availability reveals occupancy only; it grants no access.',
      debug_login: {
        issue: { method: 'POST', path: '/auth/debug-login/issue', auth: 'domain bearer plus source refresh_token',
          body: { refresh_token: 'string', previous_token: 'optional one-use token to invalidate' },
          response: { token: 'opaque one-use code', expires_in: 'positive seconds, at most 1800 and capped by source family and original proof expiry' } },
        redeem: { method: 'POST', path: '/auth/debug-login/redeem', auth: 'domain bearer',
          body: { token: 'opaque one-use code' },
          response: 'Independent access and refresh token pair; proof-bearing sessions include confidential assurance_ref and absolute assurance_expires_at, as on /auth/token'  },
        binding: 'Exact verified config_url, domain, client, source refresh family, credential epoch and selected team. Supported Nessie theme variants of the signed config URL are presentation-only; other query parameters retain their identity. Tokens travel only in POST bodies.',
      },
      admin_debug_login: {
        issue: { method: 'POST', path: '/internal/admin/debug-login/issue', auth: 'current admin bearer and exact bearer-bound HttpOnly source cookie; same-origin JSON POST',
          query: { config_url: 'exact first-party /internal/admin/config URL' }, body: { previous_token: 'optional previous code' },
          response: { url: 'canonical /admin/login URL', token: 'one-use code', expires_in: 'seconds, capped by source lifetime' } },
        redeem: { method: 'POST', path: '/internal/admin/debug-login/redeem', auth: 'one-use admin code; same-origin JSON POST',
          query: { config_url: 'exact first-party admin config URL' }, body: { token: 'one-use code' },
          response: { access_token: 'new short-lived admin bearer', expires_in: 'seconds', token_type: 'Bearer' } },
        logout: { method: 'POST', path: '/internal/admin/logout', auth: 'admin bearer; exact same-origin JSON POST',
          query: { config_url: 'exact first-party admin config URL' }, body: {}, response: { ok: true } },
        binding: 'Current ACTIVE canonical identity, SUPERUSER admin-domain role, credential epoch, exact config and source family. A new private cookie is set for the independent recipient family; refresh tokens never appear in JSON.',
      },
      product_api_concurrency:
        'Product data APIs — /org/*, /domain/*, /settings/*, /internal/org/*, /avatar/*, /email/* — share a small per-instance concurrency cap so sign-in always keeps database connections. An excess request waits briefly in FIFO order, then answers 503 with Retry-After: 1 and code PRODUCT_API_BUSY (the request had no effect). Retry after the delay with backoff and never fan out one UOA call per end-user request: resolve /org/me and settings once per session and cache them. /auth/* (including /auth/token), /oauth/*, /2fa/*, /integrations/*, /internal/admin/*, /billing/* and discovery are never limited.',
      billing_provider_unavailable:
        'Billing calls that cannot resolve the configured payment-provider account return 503 BILLING_PAYMENT_PROVIDER_UNAVAILABLE. Retain the user session, report billing temporarily unavailable and retry reads with backoff. Do not interpret this as zero credits, insufficient funds or permission to start paid work. Payment mutations retain their existing idempotency and reconciliation requirements.',
      org_me_subject_assertion:
          'GET /org/me accepts either a UOA access token or a one-minute product-signed subject assertion and returns freshly resolved org roles, never product capability verdicts. Temporary source-JWKS DNS EAI_AGAIN returns 503 INTEGRATION_JWKS_UNAVAILABLE before identity admission; retain the session and retry with backoff.',
      team_invitation_management:
        'Team invitation history, detail and resend require current members.manage for the exact target team with a user credential; credential-free backend mode requires explicit opt-in and origin-domain isolation.',
    };
  });
}

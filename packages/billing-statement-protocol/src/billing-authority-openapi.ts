import { BILLING_ORGANISATION_CAPABILITIES_PATH } from './organisation-overview-types.js';
import { billingOrganisationRequestV1JsonSchema } from './organisation-overview-schema.js';
import { BILLING_AUTHORITY_PROTOCOL_HEADER, BILLING_AUTHORITY_PROTOCOL_VERSION, BILLING_TEAM_OVERVIEW_PATH }
  from './billing-authority-types.js';
import { billingCapabilitiesV2JsonSchema, billingTeamOverviewRequestV1JsonSchema, billingTeamOverviewV1JsonSchema }
  from './billing-authority-schema.js';

const post = (operationId: string, description: string, request: unknown, response: unknown) => ({
  operationId, description, security: [{ billingAppKey: [], billingActor: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: request } } },
  responses: {
    '200': { description: 'Current UOA authority; private, no-store.',
      content: { 'application/json': { schema: response } } },
    '400': { description: 'Invalid request or BILLING_AUTHORITY_PROTOCOL_UNSUPPORTED.' },
    '401': { description: 'Invalid app, actor or original assurance.' },
    '403': { description: 'BILLING_TEAM_ACCESS_REQUIRED or inactive/foreign subject.' },
    '503': { description: 'Authority unavailable. Data dependencies fail in independent sections.' },
  },
});
export const billingAuthorityV1OpenApiDocument = {
  openapi: '3.1.0', info: { title: 'UOA billing authority and own-team read-only overview', version: '1.0.0' },
  paths: {
    [BILLING_ORGANISATION_CAPABILITIES_PATH]: { post: {
      ...post('billingAccessCapabilities',
        'Org owners/admins manage Org money. A team-only admin reads their own selected team. No financial dependency.',
        billingOrganisationRequestV1JsonSchema, billingCapabilitiesV2JsonSchema),
      parameters: [{ in: 'header', name: BILLING_AUTHORITY_PROTOCOL_HEADER, required: true,
        schema: { const: BILLING_AUTHORITY_PROTOCOL_VERSION } }],
    } },
    [BILLING_TEAM_OVERVIEW_PATH]: { post: post('billingTeamReadOnlyOverview',
      'Own-team records only. No shared Org balance, invoice, subscription, card, consent or monetary action.',
      billingTeamOverviewRequestV1JsonSchema, billingTeamOverviewV1JsonSchema) },
  },
  components: { securitySchemes: {
    billingAppKey: { type: 'apiKey', in: 'header', name: 'X-UOA-App-Key' },
    billingActor: { type: 'apiKey', in: 'header', name: 'X-UOA-Actor',
      description: 'Exact endpoint audience and current UOA subject; registered customer-lifecycle key.' },
  } },
} as const;

import { billingOrganisationCapabilitiesV1JsonSchema, billingOrganisationOverviewV1JsonSchema,
  billingOrganisationRequestV1JsonSchema, billingOrganisationOverviewRequestV1JsonSchema } from './organisation-overview-schema.js';
import { BILLING_ORGANISATION_CAPABILITIES_PATH, BILLING_ORGANISATION_OVERVIEW_PATH } from './organisation-overview-types.js';
import { BILLING_ORGANISATION_REGION_PATH } from './organisation-financial-types.js';
import { billingOrganisationFinancialV1Schemas } from './organisation-financial-schema.js';

const post = (operationId: string, description: string, request: unknown, response: unknown) => ({
  operationId, description, security: [{ billingAppKey: [], billingActor: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: request } } },
  responses: {
    '200': { description: 'Private, no-store authoritative response.', content: { 'application/json': { schema: response } } },
    '400': { description: 'Invalid request or billing context.' },
    '401': { description: 'Missing, expired or mismatched app/actor credentials.' },
    '403': { description: 'Inactive/foreign subject or BILLING_MANAGER_REQUIRED on a financial request.' },
    '409': { description: 'BILLING_CONTEXT_REQUIRED or BILLING_CONTEXT_STALE; refresh display and require a new click.' },
    '503': { description: 'Authority/database unavailable. Provider or metering section failures are represented in the overview.' },
  },
});
export const billingOrganisationV1OpenApiDocument = {
  openapi: '3.1.0', info: { title: 'UOA organisation financial overview', version: '1.2.0' },
  paths: {
    [BILLING_ORGANISATION_REGION_PATH]:{post:post('billingOrganisationRegion',
      'Financial-only subject, including explicit null team for an org manager. Read without region; choose once with region. Audited and immutable.',
      billingOrganisationFinancialV1Schemas.region_request,billingOrganisationFinancialV1Schemas.region_response)},
    [BILLING_ORGANISATION_CAPABILITIES_PATH]: { post: post('billingOrganisationCapabilities',
      'Current UOA role capability; independent from Stripe, credits and Ledger. Selected team is actor admission context.',
      billingOrganisationRequestV1JsonSchema, billingOrganisationCapabilitiesV1JsonSchema) },
    [BILLING_ORGANISATION_OVERVIEW_PATH]: { post: post('billingOrganisationOverview',
      'One organisation/account/mode financial overview. Independent sections; no numeric bill while held. Current org manager or active team manager in this org. Explicit null team requires org manager and organisation financial actor scope.',
      billingOrganisationOverviewRequestV1JsonSchema, billingOrganisationOverviewV1JsonSchema) },
  },
  components: { securitySchemes: {
    billingAppKey: { type: 'apiKey', in: 'header', name: 'X-UOA-App-Key' },
    billingActor: { type: 'apiKey', in: 'header', name: 'X-UOA-Actor',
      description: 'Short-lived product-signed actor with exact endpoint audience and current selected-team binding.' },
  } },
} as const;

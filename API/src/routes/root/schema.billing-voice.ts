import type { EndpointSchema } from './schema.js';
import { BILLING_VOICE_PATHS, billingVoiceGrantRequestV1JsonSchema, billingVoiceGrantReadRequestV1JsonSchema,
  billingVoiceQuoteRequestV1JsonSchema, billingVoiceReserveRequestV1JsonSchema, billingVoiceReadRequestV1JsonSchema,
  billingVoiceClaimRequestV1JsonSchema, billingVoiceReceiptRequestV1JsonSchema,
  billingVoiceReleaseRequestV1JsonSchema, billingVoiceStreamRequestV1JsonSchema, billingVoiceStreamReconciliationRequestV1JsonSchema } from '@unlikeotherai/billing-statement-protocol';
const schemas = {
  stream: billingVoiceStreamRequestV1JsonSchema, reconciliation: billingVoiceStreamReconciliationRequestV1JsonSchema,
  grant: billingVoiceGrantRequestV1JsonSchema, grantRead: billingVoiceGrantReadRequestV1JsonSchema,
  grantRevoke: billingVoiceGrantReadRequestV1JsonSchema, quote: billingVoiceQuoteRequestV1JsonSchema,
  reserve: billingVoiceReserveRequestV1JsonSchema, read: billingVoiceReadRequestV1JsonSchema,
  claim: billingVoiceClaimRequestV1JsonSchema, receipt: billingVoiceReceiptRequestV1JsonSchema,
  release: billingVoiceReleaseRequestV1JsonSchema,
};
export const billingVoiceEndpoints: EndpointSchema[] = Object.entries(BILLING_VOICE_PATHS).map(([key, path]) => ({
  method: 'POST', path, description: `Prepaid telephone call-leg ${key}; exact bindings and selected-team authority.`,
  auth: key === 'grant' ? 'CUSTOMER_LIFECYCLE app key and exact-endpoint X-UOA-Actor; selected-team manager'
    : 'Dedicated product VOICE_RUNTIME app key; no caller impersonation',
  body: Object.fromEntries(Object.entries(schemas[key as keyof typeof schemas].properties).map(([name, schema]) => [name, JSON.stringify(schema)])),
  response: { 200: key.startsWith('grant') ? 'BillingVoiceGrantV1' : key === 'quote' ? 'BillingVoiceQuoteV1' : key === 'reconciliation' ? 'BillingVoiceStreamReconciliationV1' : 'BillingVoiceReservationV1',
    402: 'Insufficient prepaid credits; can_dispatch=false', 409: 'Binding conflict or unproven outcome',
    503: 'Provider pricing/cutoff evidence unavailable; no admission' },
  notes: 'Strict billing-statement-protocol Voice contract 2.0.0 schemas (stable /billing/v1/voice endpoint namespace). Active grant read returns live-checked 60-second billing_origin (subject/token_version/organisation_id/team_id/expires_at); other grant responses return null; never caller authority. Optional disclosed fixed-rate Media Streams duration evidence; invoice differences never alter customer debits. Validated policy and provider cutoff proof remain required.',
}));

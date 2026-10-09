import * as schemas from './sms-schema.js';
import { BILLING_SMS_PATHS, BILLING_SMS_PROTOCOL_VERSION } from './sms-types.js';

const routes = [
  ['quote', 'QuoteRequest', 'FinalQuote', 'ENTITLEMENT'],
  ['verifyQuote', 'VerifyQuoteRequest', 'FinalQuote', 'ENTITLEMENT'],
  ['reserve', 'ReserveRequest', 'Reservation', 'ENTITLEMENT or SMS_RUNTIME for a persisted grant'],
  ['reservation', 'ReservationReadRequest', 'Reservation', 'SMS_RUNTIME'],
  ['claim', 'ClaimRequest', 'Reservation', 'SMS_RUNTIME'],
  ['receipt', 'ReceiptRequest', 'Reservation', 'SMS_RUNTIME'],
  ['release', 'ReleaseRequest', 'ReleaseResult', 'SMS_RUNTIME'],
  ['numberBegin', 'NumberBeginRequest', 'Number', 'CUSTOMER_LIFECYCLE'],
  ['numberStatus', 'NumberStatusRequest', 'Number', 'ENTITLEMENT'],
  ['numberRuntimeStatus', 'NumberRuntimeStatusRequest', 'Number', 'SMS_RUNTIME'],
  ['numberAttach', 'NumberAttachRequest', 'Number', 'SMS_RUNTIME'],
  ['numberEnd', 'NumberEndRequest', 'NumberEndResult', 'SMS_RUNTIME'],
  ['standingHold', 'StandingHoldRequest', 'StandingHold', 'CUSTOMER_LIFECYCLE'],
  ['standingStatus', 'StandingReadRequest', 'StandingHold', 'SMS_RUNTIME'],
  ['standingRetire', 'StandingReadRequest', 'StandingRetireResult', 'SMS_RUNTIME'],
  ['inboundReceipt', 'InboundReceiptRequest', 'InboundReceipt', 'SMS_RUNTIME'],
  ['grant', 'GrantRequest', 'Grant', 'CUSTOMER_LIFECYCLE'],
  ['grantRead', 'GrantReadRequest', 'Grant', 'SMS_RUNTIME'],
  ['grantRevoke', 'GrantReadRequest', 'GrantRevokeResult', 'SMS_RUNTIME'],
  ['grantQuote', 'GrantQuoteRequest', 'FinalQuote', 'SMS_RUNTIME'],
] as const;

export const billingSmsProtocolV1JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://authentication.unlikeotherai.com/schema/billing-sms-v1.json',
  definitions: Object.fromEntries(Object.entries(schemas)),
} as const;

function schema(name: string): unknown {
  const key = `billingSms${name}V1JsonSchema`;
  const value = (schemas as Record<string, unknown>)[key];
  if (!value) throw new Error(`Missing public SMS schema ${key}`);
  return value;
}

export const billingSmsV1OpenApiDocument = {
  openapi: '3.1.0', info: { title: 'UOA mobile-number and prepaid SMS', version: BILLING_SMS_PROTOCOL_VERSION },
  components: { securitySchemes: {
    appKey: { type: 'apiKey', in: 'header', name: 'X-UOA-App-Key' },
    actor: { type: 'apiKey', in: 'header', name: 'X-UOA-Actor' },
  } },
  paths: Object.fromEntries(routes.map(([path, request, response, purpose]) => [BILLING_SMS_PATHS[path], {
    post: { operationId: path, description: `App-key purpose: ${purpose}. Actor calls require an exact endpoint audience.`,
      security: [{ appKey: [], ...(purpose === 'SMS_RUNTIME' ? {} : { actor: [] }) }],
      requestBody: { required: true, content: { 'application/json': { schema: schema(request) } } },
      responses: { 200: { description: 'Customer-safe result; recovery tombstones fence delayed admissions.',
        content: { 'application/json': { schema: schema(response) } } },
      ...(path === 'reserve' || path === 'standingHold' ? { 402: {
        description: 'Prepaid funds unavailable; no dispatch authorization.', content: { 'application/json': {
          schema: schemas.billingSmsInsufficientCreditsV1JsonSchema,
        } },
      } } : {}),
      ...(path === 'numberRuntimeStatus' ? { 404: { description: 'Typed absence only; explicit end is required to fence begin.',
        content: { 'application/json': { schema: schemas.billingSmsResourceNotFoundV1JsonSchema } } } } : {}),
      },
    },
  }])),
} as const;

import * as schemas from './browser-schema.js';
import { BILLING_BROWSER_PATHS, BILLING_BROWSER_PROTOCOL_VERSION } from './browser-types.js';

const routes = [
  ['tariff', 'TariffRequest', 'Tariff', true],
  ['reserve', 'ReserveRequest', 'Reservation', true],
  ['read', 'ReadRequest', 'Reservation', false],
  ['claim', 'ReadRequest', 'Reservation', false],
  ['receipt', 'ReceiptRequest', 'Reservation', false],
  ['release', 'ReleaseRequest', 'Released', false],
] as const;
export const billingBrowserProtocolV1JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://authentication.unlikeotherai.com/schema/billing-browser-v1.json',
  definitions: Object.fromEntries(Object.entries(schemas)),
} as const;
function schema(name: string): unknown {
  const value = (schemas as Record<string, unknown>)[`billingBrowser${name}V1JsonSchema`];
  if (!value) throw new Error(`Missing public browser schema ${name}`);
  return value;
}
export const billingBrowserV1OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'UOA prepaid cloud browsers', version: BILLING_BROWSER_PROTOCOL_VERSION },
  components: {
    securitySchemes: {
      appKey: { type: 'apiKey', in: 'header', name: 'X-UOA-App-Key' },
      actor: { type: 'apiKey', in: 'header', name: 'X-UOA-Actor' },
    },
  },
  paths: Object.fromEntries(
    routes.map(([path, request, response, actor]) => [
      BILLING_BROWSER_PATHS[path],
      {
        post: {
          operationId: `browser_${path}`,
          description:
            'Requires BROWSER_RUNTIME. Actor assertions name this exact endpoint. Receipt and cancellation calls use the original reservation, without renewing human authority.',
          security: [{ appKey: [], ...(actor ? { actor: [] } : {}) }],
          requestBody: { required: true, content: { 'application/json': { schema: schema(request) } } },
          responses: {
            200: {
              description: 'Content-free usage and prepaid billing result.',
              content: { 'application/json': { schema: schema(response) } },
            },
            402: { description: 'Insufficient prepaid credits or budget; do not start a provider session.' },
            409: { description: 'Conflicting attribution or evidence; do not retry provider creation.' },
            503: {
              description:
                'Billing or current provider pricing is unavailable; do not start a provider session.',
            },
          },
        },
      },
    ]),
  ),
} as const;

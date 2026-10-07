import type { EndpointSchema } from './schema.js';

export function billingLedgerRuntimeKeyEndpoints(adminAuth: string): EndpointSchema[] {
  return [
  {
    method: 'GET', path: '/internal/admin/billing/ledger-runtime-keys', auth: adminAuth,
    description: 'List product-bound Ledger runtime-key metadata; never plaintext or digests.',
    response: { 200: '{ keys: [{ id, product, key_prefix, ledger_audience, source_domain, created_at, revoked_at }] }; no-store' },
  },
  {
    method: 'POST', path: '/internal/admin/billing/ledger-runtime-keys', auth: adminAuth,
    description: 'Issue one Ledger runtime key bound to an active product, exact HTTPS audience and original source domain; plaintext is returned once.',
    body: { product: 'active billing-service identifier', ledger_audience: 'exact HTTPS Ledger origin', source_domain: 'original product config-domain hostname' },
    response: { 200: '{ id, key_prefix, created_at, secret }; no-store; secret cannot be recovered' },
  },
  {
    method: 'POST', path: '/internal/admin/billing/ledger-runtime-keys/:keyId/revoke', auth: adminAuth,
    description: 'Revoke the exact Ledger runtime key; irreversible and audited.',
    response: { 200: '{ id, revoked_at }; no-store' },
  },
  ];
}

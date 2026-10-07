// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { billingLedgerRuntimeKeyService } from './billing-ledger-runtime-key-service';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./api-client', () => ({ createApiClient: () => api }));
afterEach(() => vi.resetAllMocks());
const metadata = { id: 'key-1', product: 'nessie', key_prefix: 'uoa_ledger_fixture',
  source_domain: 'api.nessie.works', ledger_audience: 'https://ledger.unlikeotherai.com',
  created_at: '2026-10-07T12:00:00.000Z', revoked_at: null };

it('parses only metadata; plaintext and digest in a list response fail closed', async () => {
  api.get.mockResolvedValue({ keys: [metadata] });
  expect(await billingLedgerRuntimeKeyService.list()).toEqual([metadata]);
  expect(api.get).toHaveBeenCalledWith('/internal/admin/billing/ledger-runtime-keys',
    { cache: 'no-store' });
  for (const extra of [{ secret: 'unexpected' }, { secret_digest: 'unexpected' }]) {
    api.get.mockResolvedValue({ keys: [{ ...metadata, ...extra }] });
    await expect(billingLedgerRuntimeKeyService.list()).rejects.toThrow();
  }
});
it('issues exactly the selected product/source/audience and returns the one-time response', async () => {
  const created = { id: metadata.id, key_prefix: metadata.key_prefix,
    created_at: metadata.created_at, secret: `uoa_ledger_${'a'.repeat(43)}` };
  api.post.mockResolvedValue(created);
  expect(await billingLedgerRuntimeKeyService.create('nessie', {
    sourceDomain: ' API.NESSIE.WORKS ', ledgerAudience: metadata.ledger_audience,
  })).toEqual(created);
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/internal/admin/billing/ledger-runtime-keys',
    { product: 'nessie', source_domain: metadata.source_domain,
      ledger_audience: metadata.ledger_audience }, { cache: 'no-store' });
});
it.each(['http://ledger.example', 'https://ledger.example/',
  'https://ledger.example/path', 'https://user:password@ledger.example'])
('refuses invalid audience %s before transport', async (ledgerAudience) => {
  await expect(billingLedgerRuntimeKeyService.create('nessie', {
    sourceDomain: 'api.nessie.works', ledgerAudience,
  })).rejects.toThrow();
  expect(api.post).not.toHaveBeenCalled();
});
it('encodes the exact revoke ID and uses no-store', async () => {
  api.post.mockResolvedValue({ id: 'key/id', revoked_at: metadata.created_at });
  await billingLedgerRuntimeKeyService.revoke('key/id');
  expect(api.post).toHaveBeenCalledExactlyOnceWith(
    '/internal/admin/billing/ledger-runtime-keys/key%2Fid/revoke', undefined,
    { cache: 'no-store' });
});

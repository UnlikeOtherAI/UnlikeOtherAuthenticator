import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { fetchLedgerJsonResponse } from '../../src/services/billing-ledger-http.service.js';

const url = new URL('https://ledger.unlikeotherai.com/v1/metering/portfolio');
const errors = {
  requestFailed: 'LEDGER_REQUEST_FAILED',
  responseTooLarge: 'LEDGER_RESPONSE_TOO_LARGE',
  responseInvalid: 'LEDGER_RESPONSE_INVALID',
};

function invoke(fetchMock: typeof fetch) {
  return fetchLedgerJsonResponse(
    {
      url,
      headers: {
        Accept: 'application/json',
        'X-Ledger-App-Key': 'dedicated-uoa-key',
      },
      errors,
    },
    { fetch: fetchMock },
  );
}

describe('bounded Ledger JSON response reader', () => {
  it('rejects redirects before credentials can be replayed to another origin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } }),
      );

    await expect(invoke(fetchMock as unknown as typeof fetch)).rejects.toThrow(
      'LEDGER_REQUEST_FAILED',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('hashes the exact response bytes, including multibyte UTF-8', async () => {
    const bytes = new TextEncoder().encode('{"label":"Nessie 🐉"}');
    const result = await invoke(
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    );

    expect(result.value).toEqual({ label: 'Nessie 🐉' });
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const malformed = Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    await expect(
      invoke(
        vi
          .fn()
          .mockResolvedValue(new Response(malformed, { status: 200 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('LEDGER_RESPONSE_INVALID');
  });

  it('rejects response bodies above the two-megabyte limit', async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(
      invoke(
        vi
          .fn()
          .mockResolvedValue(new Response(oversized, { status: 200 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('LEDGER_RESPONSE_TOO_LARGE');
  });
});

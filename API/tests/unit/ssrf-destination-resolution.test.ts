import { lookup } from 'node:dns/promises';
import { describe, expect, it, vi } from 'vitest';

import { PublicDestinationUnavailableError, resolvePublicDestinations } from '../../src/utils/ssrf.js';

const url = new URL('https://partner.example.com/jwks.json');

describe('public destination resolver failures', () => {
  it('preserves only temporary DNS failure as unavailable without admitting a destination', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('resolver unavailable'), { code: 'EAI_AGAIN' }));
    await expect(resolvePublicDestinations(url)).rejects.toBeInstanceOf(PublicDestinationUnavailableError);
    await expect(resolvePublicDestinations(url)).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it.each(['ENOTFOUND', 'EAI_NONAME', 'EAI_FAIL', undefined])('retains definitive DNS rejection: %s', async (code) => {
    vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('resolver rejected'), { code }));
    await expect(resolvePublicDestinations(url)).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
  });

  it.each([
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.0.0.1', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }],
    [{ address: '93.184.216.34', family: 9 }],
  ].map(destinations => ({ destinations })))('refuses unsafe destination results: $destinations', async ({ destinations }) => {
    vi.mocked(lookup).mockResolvedValueOnce(destinations);
    await expect(resolvePublicDestinations(url)).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
  });
});

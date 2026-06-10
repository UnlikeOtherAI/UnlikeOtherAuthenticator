import { describe, expect, it } from 'vitest';

import {
  isAdminStaticAssetPath,
  readAdminUiAssetIfExists,
} from '../../src/services/admin-ui.service.js';

describe('admin-ui SPA fallback', () => {
  // Regression: refreshing a deep link whose last path segment is a domain (e.g.
  // /admin/domains/api.nessie.unlikeotherai.com) used to 500 ("Request failed") because
  // path.extname() treats the trailing ".com" as a file extension, so the route tried to read it
  // as a static asset. The fix is for the asset read to report "no such file" so the route can
  // fall back to the SPA shell.
  it('flags a dotted SPA route path as asset-looking (the trap)', () => {
    expect(isAdminStaticAssetPath('domains/api.nessie.unlikeotherai.com')).toBe(true);
  });

  it('returns null (not a thrown 404) for an asset-looking path with no backing file', async () => {
    await expect(
      readAdminUiAssetIfExists({ relativePath: 'domains/api.nessie.unlikeotherai.com' }),
    ).resolves.toBeNull();
  });

  it('still rejects path traversal rather than masking it as a miss', async () => {
    await expect(
      readAdminUiAssetIfExists({ relativePath: '../../etc/passwd' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

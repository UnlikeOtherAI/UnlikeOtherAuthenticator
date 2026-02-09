import { describe, expect, it } from 'vitest';

import { createClientId } from '../../src/utils/hash.js';

describe('createClientId', () => {
  it('hashes domain + shared secret using sha256 hex (domain is normalized)', () => {
    const domain = '  ExAmPlE.CoM ';
    const sharedSecret = 'test-shared-secret';

    // sha256('example.com' + 'test-shared-secret') as lowercase hex
    expect(createClientId(domain, sharedSecret)).toBe(
      'e70baed4df97ae3296233d1779dae69751062cdeab3d81f979607e8c340c657d',
    );
  });
});


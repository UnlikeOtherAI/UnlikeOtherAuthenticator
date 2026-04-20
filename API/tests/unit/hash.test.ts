import { describe, expect, it } from 'vitest';

import { createClientId } from '../../src/utils/hash.js';

describe('createClientId', () => {
  it('hashes domain + shared secret using sha256 hex (domain is normalized)', () => {
    const domain = '  ExAmPlE.CoM ';
    const sharedSecret = 'test-shared-secret-with-enough-length';

    // sha256('example.com' + 'test-shared-secret-with-enough-length') as lowercase hex
    expect(createClientId(domain, sharedSecret)).toBe(
      '8e6ed47fc6856bc00c3f058901d28085480a7ed7a615c87ae26bc36de8342e92',
    );
  });
});

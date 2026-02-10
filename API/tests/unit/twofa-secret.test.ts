import { describe, expect, it } from 'vitest';

import { decryptTwoFaSecret, encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';

describe('twofa-secret', () => {
  it('encrypts and decrypts a secret using a derived key', () => {
    const sharedSecret = 'test-shared-secret';
    const secret = 'JBSWY3DPEHPK3PXP';

    const encrypted = encryptTwoFaSecret({ secret, sharedSecret });
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith('v1:')).toBe(true);

    const decrypted = decryptTwoFaSecret({ encryptedSecret: encrypted, sharedSecret });
    expect(decrypted).toBe(secret);
  });

  it('uses a random IV (encrypting the same secret twice yields different values)', () => {
    const sharedSecret = 'test-shared-secret';
    const secret = 'JBSWY3DPEHPK3PXP';

    const a = encryptTwoFaSecret({ secret, sharedSecret });
    const b = encryptTwoFaSecret({ secret, sharedSecret });
    expect(a).not.toBe(b);
  });
});


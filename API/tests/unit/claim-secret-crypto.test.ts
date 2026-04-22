import { describe, expect, it } from 'vitest';

import {
  decryptClaimSecret,
  encryptClaimSecret,
} from '../../src/utils/claim-secret-crypto.js';

const sharedSecret = 'test-shared-secret-with-enough-length';

describe('claim secret crypto', () => {
  it('round-trips plaintext through AES-256-GCM', () => {
    const plaintext = 'client-secret-abc-123-xyz-super-long-enough';

    const payload = encryptClaimSecret(plaintext, { sharedSecret });

    expect(payload.iv.byteLength).toBe(12);
    expect(payload.tag.byteLength).toBe(16);
    expect(Buffer.from(payload.ciphertext).toString('utf8')).not.toContain('client-secret');

    const decrypted = decryptClaimSecret(payload, { sharedSecret });
    expect(decrypted).toBe(plaintext);
  });

  it('fails with a generic error when the tag is tampered', () => {
    const payload = encryptClaimSecret('secret-value-at-least-32-bytes-long', {
      sharedSecret,
    });
    const tampered = new Uint8Array(payload.tag);
    tampered[0] = tampered[0] ^ 0xff;

    expect(() =>
      decryptClaimSecret(
        { ...payload, tag: tampered },
        { sharedSecret },
      ),
    ).toThrowError(/CLAIM_CIPHERTEXT_INVALID/);
  });

  it('fails with a generic error when the ciphertext is tampered', () => {
    const payload = encryptClaimSecret('secret-value-at-least-32-bytes-long', {
      sharedSecret,
    });
    const tampered = new Uint8Array(payload.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;

    expect(() =>
      decryptClaimSecret(
        { ...payload, ciphertext: tampered },
        { sharedSecret },
      ),
    ).toThrowError(/CLAIM_CIPHERTEXT_INVALID/);
  });

  it('rejects an IV of the wrong length', () => {
    const payload = encryptClaimSecret('secret-value-at-least-32-bytes-long', {
      sharedSecret,
    });
    expect(() =>
      decryptClaimSecret(
        { ...payload, iv: new Uint8Array(6) },
        { sharedSecret },
      ),
    ).toThrowError(/CLAIM_CIPHERTEXT_IV_INVALID/);
  });

  it('produces different ciphertext for the same plaintext across calls', () => {
    const a = encryptClaimSecret('same-plaintext-secret-for-both-calls', { sharedSecret });
    const b = encryptClaimSecret('same-plaintext-secret-for-both-calls', { sharedSecret });
    expect(Buffer.from(a.iv).toString('hex')).not.toBe(Buffer.from(b.iv).toString('hex'));
    expect(Buffer.from(a.ciphertext).toString('hex')).not.toBe(
      Buffer.from(b.ciphertext).toString('hex'),
    );
  });
});

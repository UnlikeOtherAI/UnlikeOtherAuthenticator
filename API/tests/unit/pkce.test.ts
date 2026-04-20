import { describe, expect, it } from 'vitest';

import { parseRequiredPkceChallenge } from '../../src/utils/pkce.js';

describe('PKCE validation', () => {
  it('requires an exact 43-character S256 code challenge', () => {
    const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

    expect(
      parseRequiredPkceChallenge({
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      }),
    ).toEqual({
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    expect(() =>
      parseRequiredPkceChallenge({
        codeChallenge: `${challenge}x`,
        codeChallengeMethod: 'S256',
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { parsePopupQueryParams } from './use-popup';

describe('parsePopupQueryParams', () => {
  it('parses forced 2FA enrollment setup token', () => {
    const parsed = parsePopupQueryParams(
      '?config_url=https%3A%2F%2Fclient.example.com%2Fauth%2Fconfig&twofa_enroll_required=true&twofa_setup_token=setup.jwt',
    );

    expect(parsed.twoFaSetupToken).toBe('setup.jwt');
    expect(parsed.twoFaToken).toBeNull();
  });

  it('keeps the existing 2FA verify token separate from setup state', () => {
    const parsed = parsePopupQueryParams('?twofa_token=challenge.jwt');

    expect(parsed.twoFaToken).toBe('challenge.jwt');
    expect(parsed.twoFaSetupToken).toBeNull();
  });
});

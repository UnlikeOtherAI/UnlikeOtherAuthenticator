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

  it('parses a login_token seeded alongside flow=workspace_chooser (social-callback bridge)', () => {
    const parsed = parsePopupQueryParams(
      '?config_url=https%3A%2F%2Fclient.example.com%2Fauth%2Fconfig&login_token=bridge.jwt&flow=workspace_chooser',
    );

    expect(parsed.loginToken).toBe('bridge.jwt');
  });

  it('ignores a login_token without the flow=workspace_chooser marker', () => {
    const parsed = parsePopupQueryParams('?login_token=bridge.jwt');

    expect(parsed.loginToken).toBeNull();
  });

  // Gap-fix B Task 2 (design §11.4): team_hint deep-link/switch preselect parsing.
  describe('team_hint', () => {
    it('parses a team_hint query param', () => {
      const parsed = parsePopupQueryParams(
        '?config_url=https%3A%2F%2Fclient.example.com%2Fauth%2Fconfig&team_hint=team_abc123',
      );

      expect(parsed.teamHint).toBe('team_abc123');
    });

    it('parses a slug-shaped team_hint the same way', () => {
      const parsed = parsePopupQueryParams('?team_hint=backend-team');

      expect(parsed.teamHint).toBe('backend-team');
    });

    it('is null when team_hint is absent', () => {
      const parsed = parsePopupQueryParams('?config_url=https%3A%2F%2Fclient.example.com%2Fauth%2Fconfig');

      expect(parsed.teamHint).toBeNull();
    });

    it('is null for an empty search string', () => {
      const parsed = parsePopupQueryParams('');

      expect(parsed.teamHint).toBeNull();
    });

    it('is null for a blank team_hint value', () => {
      const parsed = parsePopupQueryParams('?team_hint=%20%20');

      expect(parsed.teamHint).toBeNull();
    });
  });
});

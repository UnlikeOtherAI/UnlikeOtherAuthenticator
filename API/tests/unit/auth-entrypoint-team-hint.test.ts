import { describe, expect, it } from 'vitest';

import { sanitizeTeamHintInUrl } from '../../src/routes/auth/entrypoint.js';

/**
 * Gap-fix B Task 2 (design §11.4): `team_hint` is a client-side chooser preselect ONLY. This is
 * defense-in-depth on top of the frontend's own no-match-is-a-no-op behaviour — an invalid hint
 * must never even reach the SPA bootstrap. The byte-identical guarantee for `workspace_selection:
 * "off"` (and for every request that never carries a `team_hint`) rests on the fast-path below
 * leaving `rawUrl` completely untouched.
 */
describe('sanitizeTeamHintInUrl', () => {
  it('leaves a URL with no team_hint completely untouched (byte-identical fast path)', () => {
    const url =
      '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback';
    expect(sanitizeTeamHintInUrl(url)).toBe(url);
  });

  it('leaves a URL with no query string at all untouched', () => {
    expect(sanitizeTeamHintInUrl('/auth')).toBe('/auth');
  });

  it('leaves a valid team_hint (id-shaped) untouched', () => {
    const url = '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=team_abc123';
    expect(sanitizeTeamHintInUrl(url)).toBe(url);
  });

  it('leaves a valid team_hint (slug-shaped) untouched', () => {
    const url = '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=backend-team';
    expect(sanitizeTeamHintInUrl(url)).toBe(url);
  });

  it('strips an invalid team_hint (disallowed characters) while preserving the other params', () => {
    const url =
      '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=%3Cscript%3E&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback';
    const result = sanitizeTeamHintInUrl(url);
    expect(result).not.toContain('team_hint');
    const parsed = new URL(result, 'http://localhost');
    expect(parsed.searchParams.get('config_url')).toBe('https://client.example.com/auth-config');
    expect(parsed.searchParams.get('redirect_url')).toBe('https://client.example.com/oauth/callback');
  });

  it('strips a team_hint that exceeds the 256-char limit', () => {
    const longHint = 'a'.repeat(257);
    const url = `/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=${longHint}`;
    const result = sanitizeTeamHintInUrl(url);
    expect(result).not.toContain('team_hint');
  });

  it('drops the trailing "?" when team_hint was the only query param and gets stripped', () => {
    const url = '/auth?team_hint=%3Cscript%3E';
    expect(sanitizeTeamHintInUrl(url)).toBe('/auth');
  });
});

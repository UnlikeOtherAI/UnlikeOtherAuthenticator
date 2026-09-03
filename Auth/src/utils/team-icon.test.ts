import { describe, expect, it } from 'vitest';

import { hashTeamId, teamAvatarColor, teamInitials } from './team-icon.js';

describe('hashTeamId / teamAvatarColor', () => {
  it('is stable for the same teamId', () => {
    const teamId = 'team_abc123';
    expect(hashTeamId(teamId)).toBe(hashTeamId(teamId));
    expect(teamAvatarColor(teamId)).toBe(teamAvatarColor(teamId));
  });

  it('differs for different teamIds (no collisions for these fixtures)', () => {
    expect(teamAvatarColor('team_1')).not.toBe(teamAvatarColor('team_2'));
  });

  it('always returns a well-formed hsl() color', () => {
    const color = teamAvatarColor('team_xyz');
    expect(color).toMatch(/^hsl\(\d+, 55%, 45%\)$/);
  });
});

describe('teamInitials', () => {
  it('uses the first letter of the first two words', () => {
    expect(teamInitials('Backend Team')).toBe('BT');
  });

  it('falls back to the first two characters for a single-word name', () => {
    expect(teamInitials('Acme')).toBe('AC');
  });

  it('handles extra whitespace', () => {
    expect(teamInitials('  Growth   Squad  ')).toBe('GS');
  });

  it('returns a placeholder for an empty name', () => {
    expect(teamInitials('')).toBe('?');
  });
});

import { describe, expect, it } from 'vitest';

import { hashTeamId, workspaceAvatarColor, workspaceInitials } from './workspace-icon.js';

describe('hashTeamId / workspaceAvatarColor', () => {
  it('is stable for the same teamId', () => {
    const teamId = 'team_abc123';
    expect(hashTeamId(teamId)).toBe(hashTeamId(teamId));
    expect(workspaceAvatarColor(teamId)).toBe(workspaceAvatarColor(teamId));
  });

  it('differs for different teamIds (no collisions for these fixtures)', () => {
    expect(workspaceAvatarColor('team_1')).not.toBe(workspaceAvatarColor('team_2'));
  });

  it('always returns a well-formed hsl() color', () => {
    const color = workspaceAvatarColor('team_xyz');
    expect(color).toMatch(/^hsl\(\d+, 55%, 45%\)$/);
  });
});

describe('workspaceInitials', () => {
  it('uses the first letter of the first two words', () => {
    expect(workspaceInitials('Backend Team')).toBe('BT');
  });

  it('falls back to the first two characters for a single-word name', () => {
    expect(workspaceInitials('Acme')).toBe('AC');
  });

  it('handles extra whitespace', () => {
    expect(workspaceInitials('  Growth   Squad  ')).toBe('GS');
  });

  it('returns a placeholder for an empty name', () => {
    expect(workspaceInitials('')).toBe('?');
  });
});

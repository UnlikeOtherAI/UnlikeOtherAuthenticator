import { describe, expect, it } from 'vitest';

import {
  describeInvitation,
  describeInviteDestination,
} from '../../src/services/team-invite-copy.js';

describe('describeInviteDestination', () => {
  it('names the team and its organisation', () => {
    expect(describeInviteDestination('Design', 'Acme')).toBe('the Design team at Acme');
  });

  it('does not say "team" twice when the team name already ends with it', () => {
    expect(describeInviteDestination('Beta Team', 'Acme')).toBe('the Beta Team at Acme');
  });

  it('is just the team when it is named like its organisation', () => {
    expect(describeInviteDestination('UnlikeOtherAI', 'unlikeotherai')).toBe('UnlikeOtherAI');
  });
});

describe('describeInvitation', () => {
  it('names the inviter and the product', () => {
    expect(
      describeInvitation({
        inviterName: 'Ondra Rafaj',
        teamName: 'Design',
        organisationName: 'Acme',
        productName: 'Nessie',
      }),
    ).toBe('Ondra Rafaj invited you to join the Design team at Acme on Nessie.');
  });

  it('names no sender when the inviter has no name', () => {
    expect(
      describeInvitation({ inviterName: '  ', teamName: 'Design', organisationName: 'Acme' }),
    ).toBe('You’ve been invited to join the Design team at Acme.');
  });
});

import { describe, expect, it } from 'vitest';

import {
  cleanInviteDisplayName,
  describeInvitation,
  describeInviteDestination,
} from '../../src/services/team-invite-copy.js';

describe('describeInviteDestination', () => {
  it('names the team and its organisation', () => {
    expect(describeInviteDestination('Design', 'Acme')).toBe('the Design team at Acme');
  });

  it('does not say "team" twice when the name already says it', () => {
    expect(describeInviteDestination('Beta Team', 'Acme')).toBe('the Beta Team at Acme');
    expect(describeInviteDestination('Team Alpha', 'Acme')).toBe('the Team Alpha at Acme');
  });

  it('does not double the article', () => {
    expect(describeInviteDestination('The Avengers', 'Acme')).toBe('The Avengers team at Acme');
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

  it('does not repeat an organisation that shares the product’s name', () => {
    expect(
      describeInvitation({ teamName: 'Design', organisationName: 'Nessie', productName: 'nessie' }),
    ).toBe('You’ve been invited to join the Design team at Nessie.');
  });

  it('does not end on a double full stop', () => {
    expect(describeInvitation({ teamName: 'Design', organisationName: 'Acme Inc.' })).toBe(
      'You’ve been invited to join the Design team at Acme Inc.',
    );
  });
});

describe('cleanInviteDisplayName', () => {
  it('drops control and bidirectional-override characters and collapses whitespace', () => {
    expect(cleanInviteDisplayName('Ada‮  Love\nlace\u0007')).toBe('Ada Love lace');
  });

  it('caps a long name', () => {
    const cleaned = cleanInviteDisplayName('x'.repeat(200));
    expect(cleaned).toHaveLength(80);
    expect(cleaned?.endsWith('…')).toBe(true);
  });

  it('is null for nothing at all', () => {
    expect(cleanInviteDisplayName('​ \n')).toBeNull();
    expect(cleanInviteDisplayName(undefined)).toBeNull();
  });
});

/**
 * The words every invitation surface uses for "who invited you, to what".
 *
 * The invitation e-mail and its landing pages are read by someone who may never have heard of
 * the product, so they speak to that person directly, name the inviter when UOA knows their name,
 * and describe the team the way a person would. One module keeps the e-mail and the pages from
 * drifting into two phrasings of the same invitation.
 */

/**
 * The team, and its organisation when naming it adds information. An organisation's first team is
 * often called the same as the organisation itself, and "UnlikeOtherAI on UnlikeOtherAI" reads
 * like a mistake — so a team named like its organisation is just the team.
 */
export function describeInviteDestination(teamName: string, organisationName: string): string {
  const team = teamName.trim();
  const organisation = organisationName.trim();
  if (!organisation || team.toLowerCase() === organisation.toLowerCase()) return team;
  const noun = /\bteam$/i.test(team) ? '' : ' team';
  return `the ${team}${noun} at ${organisation}`;
}

/**
 * "Alice invited you to join the Design team at Acme on Nessie." The inviter is a name or nothing
 * (see `invite-inviter-label.service.ts`); without one the sentence names no sender.
 */
export function describeInvitation(params: {
  inviterName?: string | null;
  teamName: string;
  organisationName: string;
  productName?: string | null;
}): string {
  const destination = describeInviteDestination(params.teamName, params.organisationName);
  const product = params.productName?.trim();
  const where = product ? ` on ${product}` : '';
  const inviter = params.inviterName?.trim();
  return inviter
    ? `${inviter} invited you to join ${destination}${where}.`
    : `You’ve been invited to join ${destination}${where}.`;
}

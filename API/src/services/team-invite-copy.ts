/**
 * The words every invitation surface uses for "who invited you, to what".
 *
 * The invitation e-mail and its landing pages are read by someone who may never have heard of
 * the product, so they speak to that person directly, name the inviter when UOA knows their name,
 * and describe the team the way a person would. One module keeps the e-mail and the pages from
 * drifting into two phrasings of the same invitation.
 */

/** Longest display name an invitation repeats; a name is a greeting, not a message. */
const MAX_NAME_LENGTH = 80;

/**
 * A person's display name made safe to repeat in a subject line or a sentence. Display names are
 * chosen by users, and an inviter's lands in the subject of mail UOA signs, so control and
 * bidirectional-override characters are dropped, whitespace is collapsed and the length capped.
 */
export function cleanInviteDisplayName(value: string | null | undefined): string | null {
  const cleaned = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME_LENGTH ? `${cleaned.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : cleaned;
}

/**
 * The team, and its organisation when naming it adds information. An organisation's first team is
 * often called the same as the organisation itself, and "UnlikeOtherAI on UnlikeOtherAI" reads
 * like a mistake — so a team named like its organisation is just the team. A name that already
 * says "team" ("Beta Team", "Team Alpha") or starts with "The" is not wrapped in "the … team".
 */
export function describeInviteDestination(teamName: string, organisationName: string): string {
  const team = teamName.trim();
  const organisation = organisationName.trim();
  if (!organisation || team.toLowerCase() === organisation.toLowerCase()) return team;
  const saysTeam = /^team\b|\bteam$/i.test(team);
  const article = /^the\s/i.test(team) ? '' : 'the ';
  return `${article}${team}${saysTeam ? '' : ' team'} at ${organisation}`;
}

/**
 * "Alice invited you to join the Design team at Acme on Nessie." The inviter is a name or nothing
 * (see `invite-inviter-label.service.ts`); without one the sentence names no sender. The product is
 * named only when the product itself has a name — never a config host — and not when the
 * organisation already carries it.
 */
export function describeInvitation(params: {
  inviterName?: string | null;
  teamName: string;
  organisationName: string;
  productName?: string | null;
}): string {
  const destination = describeInviteDestination(params.teamName, params.organisationName);
  const product = params.productName?.trim();
  const repeatsOrganisation = product?.toLowerCase() === params.organisationName.trim().toLowerCase();
  const where = product && !repeatsOrganisation ? ` on ${product}` : '';
  const inviter = cleanInviteDisplayName(params.inviterName);
  const sentence = inviter
    ? `${inviter} invited you to join ${destination}${where}`
    : `You’ve been invited to join ${destination}${where}`;
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

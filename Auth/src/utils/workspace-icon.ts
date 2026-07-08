/**
 * Deterministic workspace icon fallback (design §11.3): when a team/org has no `iconUrl`, every
 * surface (the Auth chooser, a consuming product's sidebar) must render the *same* initials-on-
 * color badge for a given `teamId`, with no color stored anywhere. Documented here so a consuming
 * product can reproduce it pixel-for-pixel:
 *
 *   1. hash the teamId with djb2 (`hashTeamId`)
 *   2. hue = hash % 360, fixed saturation 55% / lightness 45% (`workspaceAvatarColor`) — an
 *      HSL wheel gives good separation between adjacent teams without a stored palette
 *   3. initials = first letter of the first two words of the team name, uppercased
 *      (`workspaceInitials`); a single-word name uses its first two characters
 */

/** djb2 string hash, kept unsigned via `>>> 0`. */
export function hashTeamId(teamId: string): number {
  let hash = 5381;
  for (let i = 0; i < teamId.length; i++) {
    hash = (hash * 33) ^ teamId.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Deterministic `hsl(...)` background for a team's fallback avatar. */
export function workspaceAvatarColor(teamId: string): string {
  const hue = hashTeamId(teamId) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** Up to two uppercase initials for a team/workspace name. */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

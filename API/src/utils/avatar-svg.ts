/**
 * Deterministic, non-AI generated avatars (Docs/Auth/avatars.md §2).
 *
 * Pure and dependency-free: same `userId` + style + size always yields byte-identical SVG, on any
 * instance, so responses are cacheable and a user's fallback avatar never flickers between styles.
 *
 * The seed and colour contract is deliberately the same one documented for team icons in
 * `Auth/src/utils/team-icon.ts` (djb2 hash → `hsl(hue, 55%, 45%)`), reimplemented here rather
 * than imported so the API has no cross-team dependency:
 *
 *   1. seed  = djb2(userId), unsigned
 *   2. hue   = seed % 360, saturation 55%, lightness 45%
 *   3. style = ?style= override → config `avatars.default_style` → AVATAR_STYLES[seed % 4]
 *
 * Output is server-authored markup only: no <script>, no <foreignObject>, no external references
 * (`url(...)`, `xlink:href`, `<image>`), so the restrictive CSP the routes send is never fighting
 * the document. Callers must keep it that way — see `tests/unit/avatar-svg.test.ts`.
 */

import { renderMono, renderRings, renderTiles, renderWaves } from './avatar-svg.styles.js';

export const AVATAR_STYLES = ['tiles', 'waves', 'rings', 'mono'] as const;

export type AvatarStyle = (typeof AVATAR_STYLES)[number];

export const AVATAR_DEFAULT_SIZE = 128;
export const AVATAR_MIN_SIZE = 16;
export const AVATAR_MAX_SIZE = 512;

/** The `viewBox` is constant; `size` only changes the rendered width/height. */
export const AVATAR_VIEWBOX = '0 0 100 100';

/** djb2 string hash, kept unsigned via `>>> 0` — the team-icon contract. */
export function djb2(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

export function isAvatarStyle(value: unknown): value is AvatarStyle {
  return typeof value === 'string' && (AVATAR_STYLES as readonly string[]).includes(value);
}

/** Stable pseudo-random style for a user when nothing else selected one. */
export function pickAvatarStyle(userId: string): AvatarStyle {
  return AVATAR_STYLES[djb2(userId) % AVATAR_STYLES.length];
}

/**
 * Style selection order (spec §2): explicit query override wins, then the domain's signed config
 * claim, then the stable per-user pick. Invalid values are treated as absent — the callers parse
 * the query with zod, so an unparseable `?style=` never reaches here as a string.
 */
export function resolveAvatarStyle(params: {
  userId: string;
  requested?: AvatarStyle | null;
  configDefault?: AvatarStyle | null;
}): AvatarStyle {
  if (isAvatarStyle(params.requested)) return params.requested;
  if (isAvatarStyle(params.configDefault)) return params.configDefault;
  return pickAvatarStyle(params.userId);
}

/** Clamp `?size=` into the supported range; anything unusable falls back to the default. */
export function clampAvatarSize(size?: number | null): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return AVATAR_DEFAULT_SIZE;
  const rounded = Math.round(size);
  if (rounded < AVATAR_MIN_SIZE) return AVATAR_MIN_SIZE;
  if (rounded > AVATAR_MAX_SIZE) return AVATAR_MAX_SIZE;
  return rounded;
}

export function generateAvatarSvg(params: {
  userId: string;
  style: AvatarStyle;
  size?: number;
}): string {
  const seed = djb2(params.userId);
  const size = clampAvatarSize(params.size);
  const body = renderStyle(params.style, seed);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${AVATAR_VIEWBOX}" ` +
    `width="${size}" height="${size}" role="img" aria-label="avatar">` +
    body +
    '</svg>'
  );
}

function renderStyle(style: AvatarStyle, seed: number): string {
  switch (style) {
    case 'tiles':
      return renderTiles(seed);
    case 'waves':
      return renderWaves(seed);
    case 'rings':
      return renderRings(seed);
    case 'mono':
      return renderMono(seed);
  }
}

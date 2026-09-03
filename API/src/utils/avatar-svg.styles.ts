/**
 * The four generated-avatar styles (Docs/Auth/avatars.md §2). Split out of `avatar-svg.ts` so the
 * public generator API stays small; both files are pure, dependency-free, and deterministic.
 *
 * Everything here is driven by `mulberry32(seed)`, a tiny deterministic PRNG seeded from the djb2
 * hash of the user id. Same seed → same sequence → byte-identical markup, which is what makes the
 * ETag and the 24h cache lifetime on generated avatars safe.
 *
 * Colours follow the team-icon contract: `hsl(hue, 55%, 45%)` with fixed hue offsets for the
 * secondary colours. `mono` is the deliberate exception — black, white and greys only.
 */

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed 2-decimal formatting so output never depends on float-to-string defaults. */
function n(value: number): string {
  return value.toFixed(2);
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${((hue % 360) + 360) % 360}, ${saturation}%, ${lightness}%)`;
}

type Palette = {
  background: string;
  primary: string;
  secondary: string;
};

/** hue = seed % 360, saturation 55%, lightness 45% — plus fixed offsets for the second colour. */
function palette(seed: number): Palette {
  const hue = seed % 360;
  return {
    background: hsl(hue, 55, 95),
    primary: hsl(hue, 55, 45),
    secondary: hsl(hue + 150, 55, 45),
  };
}

function backgroundRect(fill: string): string {
  return `<rect width="100" height="100" fill="${fill}"/>`;
}

// ---------------------------------------------------------------------------
// tiles — 5×5 identicon mosaic, mirrored about the vertical centre axis
// ---------------------------------------------------------------------------

export function renderTiles(seed: number): string {
  const random = mulberry32(seed);
  const colors = palette(seed);
  const cell = 20;
  const parts: string[] = [backgroundRect(colors.background)];

  // Generate the left three columns only; columns 3 and 4 mirror columns 1 and 0 so every
  // avatar is symmetric (the identicon look) instead of visually random noise.
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 5; row++) {
      const roll = random();
      if (roll < 0.42) continue;
      const fill = roll < 0.75 ? colors.primary : colors.secondary;
      const columns = column === 2 ? [2] : [column, 4 - column];
      for (const x of columns) {
        parts.push(
          `<rect x="${n(x * cell)}" y="${n(row * cell)}" width="${n(cell)}" height="${n(cell)}" fill="${fill}"/>`,
        );
      }
    }
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// waves — three to four stacked bands built from cubic Bézier paths
// ---------------------------------------------------------------------------

export function renderWaves(seed: number): string {
  const random = mulberry32(seed);
  const hue = seed % 360;
  const bandCount = 3 + Math.floor(random() * 2); // 3 or 4
  const parts: string[] = [backgroundRect(hsl(hue, 55, 95))];

  for (let band = 0; band < bandCount; band++) {
    // Bands descend the tile; each baseline sits a little above where the next one starts so the
    // fills overlap and the darker band on top reads as a crest rather than a gap.
    const baseline = 18 + (band * 70) / bandCount + random() * 8;
    const amplitude = 6 + random() * 10;
    const lightness = 62 - band * 9;
    const fill = hsl(hue + band * 18, 55, Math.max(28, lightness));

    const start = baseline;
    const control1 = baseline - amplitude;
    const control2 = baseline + amplitude;
    const end = baseline + (random() - 0.5) * 8;

    parts.push(
      `<path d="M0 ${n(start)} C ${n(25)} ${n(control1)}, ${n(60)} ${n(control2)}, ${n(100)} ${n(end)} ` +
        `L100 100 L0 100 Z" fill="${fill}"/>`,
    );
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// rings — concentric rings with seed-varied radii, stroke widths and centre offset
// ---------------------------------------------------------------------------

export function renderRings(seed: number): string {
  const random = mulberry32(seed);
  const colors = palette(seed);
  const hue = seed % 360;
  const centerX = 50 + (random() - 0.5) * 24;
  const centerY = 50 + (random() - 0.5) * 24;
  const ringCount = 3 + Math.floor(random() * 3); // 3 to 5
  const parts: string[] = [backgroundRect(colors.background)];

  let radius = 8 + random() * 6;
  for (let ring = 0; ring < ringCount; ring++) {
    // The corners of the tile sit ~71 units from the centre; a larger ring would be clipped away
    // entirely, so stop rather than emit invisible geometry.
    if (radius > 68) break;
    const strokeWidth = 3 + random() * 7;
    const stroke = hsl(hue + (ring % 2 === 0 ? 0 : 150), 55, 38 + ring * 6);
    parts.push(
      `<circle cx="${n(centerX)}" cy="${n(centerY)}" r="${n(radius)}" fill="none" ` +
        `stroke="${stroke}" stroke-width="${n(strokeWidth)}"/>`,
    );
    radius += strokeWidth + 3 + random() * 6;
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// mono — black and white only: diagonal stripes or quarter-circle truchet tiles
// ---------------------------------------------------------------------------

const MONO_LIGHT = '#ffffff';
const MONO_DARK = '#000000';

export function renderMono(seed: number): string {
  const random = mulberry32(seed);
  // One bit of the seed picks the pattern; both are strictly black/white.
  return random() < 0.5 ? renderMonoStripes(random) : renderMonoTruchet(random);
}

function renderMonoStripes(random: () => number): string {
  const parts: string[] = [backgroundRect(MONO_LIGHT)];
  const stripeWidth = 6 + random() * 8;
  const gap = stripeWidth + 4 + random() * 8;
  const leaning = random() < 0.5 ? 1 : -1;

  // Draw beyond the viewBox on both sides so the diagonals reach every corner; the SVG clips.
  for (let offset = -100; offset < 200; offset += gap) {
    const top = offset;
    const bottom = offset + leaning * 100;
    parts.push(
      `<path d="M${n(top)} 0 L${n(top + stripeWidth)} 0 L${n(bottom + stripeWidth)} 100 ` +
        `L${n(bottom)} 100 Z" fill="${MONO_DARK}"/>`,
    );
  }

  return `<g>${parts.join('')}</g>`;
}

function renderMonoTruchet(random: () => number): string {
  const parts: string[] = [backgroundRect(MONO_LIGHT)];
  const cell = 25;

  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      const x = column * cell;
      const y = row * cell;
      const flipped = random() < 0.5;
      // Two quarter-circles per tile; flipping which corners they hang off is the whole pattern.
      parts.push(
        flipped
          ? `<path d="M${n(x)} ${n(y)} A ${n(cell)} ${n(cell)} 0 0 1 ${n(x + cell)} ${n(y)} Z" fill="${MONO_DARK}"/>` +
              `<path d="M${n(x)} ${n(y + cell)} A ${n(cell)} ${n(cell)} 0 0 0 ${n(x + cell)} ${n(y + cell)} Z" fill="${MONO_DARK}"/>`
          : `<path d="M${n(x)} ${n(y)} A ${n(cell)} ${n(cell)} 0 0 1 ${n(x)} ${n(y + cell)} Z" fill="${MONO_DARK}"/>` +
              `<path d="M${n(x + cell)} ${n(y)} A ${n(cell)} ${n(cell)} 0 0 0 ${n(x + cell)} ${n(y + cell)} Z" fill="${MONO_DARK}"/>`,
      );
    }
  }

  return `<g>${parts.join('')}</g>`;
}

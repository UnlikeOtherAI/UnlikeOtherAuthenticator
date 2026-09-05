/**
 * DNS-grade slug rules, shared by organisation and team labels.
 *
 * Before this package there were five independent slugifiers in the repository
 * that disagreed on transliteration, length and fallback. They could disagree
 * while a slug was only a URL path segment. They cannot now: a slug is a DNS
 * label in a tenant hostname, so a label one path accepts and another rejects
 * is a hostname that resolves for one caller and 404s for the next.
 *
 * Two entry points, deliberately different:
 *
 * - `deriveSlugBase(name)` — for a slug the product is inventing from a name
 *   nobody offered as a slug. It always returns something valid, because
 *   refusing here would mean refusing to create a team whose name is legal.
 * - `checkSlug(value)` — for a slug a person typed. It refuses, and says why,
 *   because silently storing something other than what someone typed into an
 *   address bar field is worse than telling them it will not work.
 *
 * The old `normalizeTeamSlug` blurred these: its rejection branch was
 * unreachable behind a normaliser that always produced a valid label, so an
 * explicitly supplied `"a"` was stored as `team` without comment.
 */
import { isStructurallyReserved, reservedLabelsFor } from './reserved.js';

export { RESERVED_LABELS, reservedLabelsFor, isStructurallyReserved } from './reserved.js';

/** Shortest label that still reads as a name rather than an initial. */
export const SLUG_MIN_LENGTH = 2;

/** RFC 1035 maximum for a single DNS label, in octets. */
export const SLUG_MAX_LENGTH = 63;

/** Letters, digits and interior hyphens; must start and end alphanumeric. */
export const SLUG_SHAPE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ALL_DIGITS_RE = /^[0-9]+$/;

export type SlugRejection =
  | 'too_short'
  | 'too_long'
  | 'charset'
  | 'double_hyphen'
  | 'all_digits'
  | 'reserved';

export type SlugCheck =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: SlugRejection };

export interface SlugOptions {
  /** Product-declared labels to reserve on top of the base list. */
  readonly reserved?: Iterable<string>;
}

/**
 * Coerce arbitrary text towards a label: fold accents, drop what is not
 * representable, and collapse everything else to single hyphens.
 *
 * May return an empty string. Callers decide what that means — `deriveSlugBase`
 * substitutes a fallback, `checkSlug` reports why the input failed.
 */
export function normalizeSlugBase(value: string): string {
  const folded = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    // Combining marks left behind by NFKD, so "Ondřej" folds to "ondrej".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '');

  return folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** Truncate to the DNS limit without leaving a trailing hyphen behind. */
function truncateToLabel(value: string, max: number = SLUG_MAX_LENGTH): string {
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/-+$/g, '');
}

/**
 * Validate a slug somebody chose, and say why it fails.
 *
 * The order of checks is the order the messages should be read in: shape
 * before meaning, so "you used a space" is never reported as "that name is
 * taken by us".
 */
export function checkSlug(value: string, options: SlugOptions = {}): SlugCheck {
  const candidate = value.trim().toLowerCase();

  if (candidate.length < SLUG_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (candidate.length > SLUG_MAX_LENGTH) return { ok: false, reason: 'too_long' };

  // Checked before the shape regex so a doubled hyphen is named as itself
  // rather than reported as a generic charset failure. This also covers every
  // R-LDH label, `xn--` included.
  if (candidate.includes('--')) return { ok: false, reason: 'double_hyphen' };
  if (!SLUG_SHAPE_RE.test(candidate)) return { ok: false, reason: 'charset' };

  // Legal DNS, but `12.34.nessie.works` reads as an address, and some
  // resolvers and URL parsers special-case all-numeric labels.
  if (ALL_DIGITS_RE.test(candidate)) return { ok: false, reason: 'all_digits' };

  if (isStructurallyReserved(candidate)) return { ok: false, reason: 'reserved' };
  if (reservedLabelsFor(options.reserved).has(candidate)) {
    return { ok: false, reason: 'reserved' };
  }

  return { ok: true, slug: candidate };
}

/** Whether a label is reserved, by list or by structure. */
export function isReservedLabel(slug: string, extra?: Iterable<string>): boolean {
  const candidate = slug.trim().toLowerCase();
  return isStructurallyReserved(candidate) || reservedLabelsFor(extra).has(candidate);
}

export interface DeriveOptions {
  /**
   * Label used when a name carries nothing usable — "团队", "!!!", "" all
   * normalise to empty. Should say what kind of thing it names.
   */
  readonly fallback: string;
}

/**
 * Derive a syntactically valid label from a display name.
 *
 * Guarantees shape only: the result satisfies every rule in `checkSlug` except
 * `reserved`. Reservation and uniqueness both need context this function does
 * not have — a product's extra labels, and the rows already in the table — so
 * the caller's resolver handles a reserved derivation the same way it handles
 * a taken one, by suffixing.
 */
export function deriveSlugBase(name: string, options: DeriveOptions): string {
  const fallback = normalizeSlugBase(options.fallback) || 'x';
  const base = truncateToLabel(normalizeSlugBase(name));

  if (base.length < SLUG_MIN_LENGTH) return truncateToLabel(fallback);

  // A name that is only digits ("2026") would otherwise produce a label that
  // reads as an address. Keep the digits — they are what the person typed —
  // and qualify them.
  if (ALL_DIGITS_RE.test(base)) {
    return truncateToLabel(`${fallback}-${base}`);
  }

  return base;
}

/**
 * Append a disambiguating suffix to a derived base, keeping it within the
 * label limit.
 *
 * The suffix is supplied rather than generated here so callers keep control of
 * randomness — the organisation path uses a random 4-character suffix
 * deliberately, because an incrementing one leaks how many organisations share
 * a name.
 */
export function withSlugSuffix(base: string, suffix: string): string {
  const tail = `-${suffix}`;
  const room = Math.max(1, SLUG_MAX_LENGTH - tail.length);
  const trimmed = base.slice(0, room).replace(/-+$/g, '');
  return `${trimmed || 'x'}${tail}`;
}

/** Characters a disambiguating suffix is drawn from. */
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Default suffix length, matching the organisation path this package replaced. */
export const SLUG_SUFFIX_LENGTH = 4;

/**
 * A random suffix for disambiguating a derived slug.
 *
 * Random rather than incrementing, and that is the whole point: `acme-2` tells
 * anyone who can read a hostname that exactly one other tenant chose the same
 * name, and `acme-37` tells them there are thirty-six. `Docs/brief.md` records
 * that reasoning for organisations; teams now share it.
 *
 * Uses `globalThis.crypto` rather than `node:crypto` so the same module works
 * in the browser, where the creation dialog previews a slug before submitting
 * it. Rejection sampling keeps the distribution flat — the alphabet is 36
 * characters and a byte is 256 values, so plain modulo would favour the first
 * four letters.
 */
type CryptoLike = { getRandomValues: (array: Uint8Array) => Uint8Array };

/**
 * The platform CSPRNG, reached without depending on DOM or Node type
 * definitions — this package is compiled for both, and naming either would make
 * it build in one and not the other.
 */
function webCrypto(): CryptoLike {
  const candidate = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!candidate?.getRandomValues) {
    // Deterministic failure rather than a quiet fallback to Math.random: the
    // suffix exists so a hostname does not disclose how many tenants share a
    // name, and a predictable one would not do that job while looking as if it
    // did. Present in every browser and in Node 18 and later.
    throw new Error('[slug] no Web Crypto available for slug suffix generation');
  }
  return candidate;
}

export function randomSlugSuffix(length: number = SLUG_SUFFIX_LENGTH): string {
  const crypto = webCrypto();
  const limit = Math.floor(256 / SUFFIX_ALPHABET.length) * SUFFIX_ALPHABET.length;
  let out = '';

  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
    }
  }

  return out;
}

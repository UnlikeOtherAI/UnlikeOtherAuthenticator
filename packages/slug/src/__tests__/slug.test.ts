import { describe, expect, it } from 'vitest';

import {
  SLUG_MAX_LENGTH,
  checkSlug,
  deriveSlugBase,
  isReservedLabel,
  normalizeSlugBase,
  withSlugSuffix,
} from '../index.js';

const derive = (name: string) => deriveSlugBase(name, { fallback: 'team' });

describe('normalizeSlugBase', () => {
  it('folds accents rather than dropping the letters', () => {
    expect(normalizeSlugBase('Ondřej Rafaj')).toBe('ondrej-rafaj');
    expect(normalizeSlugBase('Über Straße')).toBe('uber-strae');
  });

  it('collapses runs of punctuation to single hyphens and trims the ends', () => {
    expect(normalizeSlugBase('  --Hello,,, World!--  ')).toBe('hello-world');
  });

  it('returns empty when nothing survives, rather than inventing a label', () => {
    expect(normalizeSlugBase('团队')).toBe('');
    expect(normalizeSlugBase('!!!')).toBe('');
  });
});

describe('checkSlug — an explicitly chosen label is refused, not coerced', () => {
  it('accepts an ordinary label', () => {
    expect(checkSlug('design')).toEqual({ ok: true, slug: 'design' });
  });

  it('lower-cases and trims what it accepts', () => {
    expect(checkSlug('  Design  ')).toEqual({ ok: true, slug: 'design' });
  });

  it('refuses a single character instead of silently storing "team"', () => {
    // This is the regression the old normalizeTeamSlug could not catch: its
    // rejection branch sat behind a normaliser that had already substituted a
    // fallback, so "a" was stored as "team" with no error.
    expect(checkSlug('a')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('refuses a label longer than a DNS label may be', () => {
    expect(checkSlug('a'.repeat(SLUG_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(checkSlug('a'.repeat(SLUG_MAX_LENGTH)).ok).toBe(true);
  });

  it('names a doubled hyphen as itself, which also covers xn--', () => {
    expect(checkSlug('west--side')).toEqual({ ok: false, reason: 'double_hyphen' });
    expect(checkSlug('xn--bcher-kva')).toEqual({ ok: false, reason: 'double_hyphen' });
  });

  it('refuses spaces, punctuation and leading or trailing hyphens', () => {
    expect(checkSlug('my team')).toEqual({ ok: false, reason: 'charset' });
    expect(checkSlug('-design')).toEqual({ ok: false, reason: 'charset' });
    expect(checkSlug('design-')).toEqual({ ok: false, reason: 'charset' });
  });

  it('refuses an all-numeric label, which reads as an address', () => {
    expect(checkSlug('2026')).toEqual({ ok: false, reason: 'all_digits' });
    expect(checkSlug('2026-plans').ok).toBe(true);
  });

  it('refuses reserved labels, including the eight the org path already had', () => {
    for (const label of ['api', 'admin', 'www', 'mx', 'default', 'settings']) {
      expect(checkSlug(label)).toEqual({ ok: false, reason: 'reserved' });
    }
  });

  it('refuses a structurally reserved label', () => {
    expect(checkSlug('_acme')).toEqual({ ok: false, reason: 'charset' });
  });

  it('lets a product reserve its own hostnames without un-reserving the base', () => {
    expect(checkSlug('nessie', { reserved: ['nessie'] })).toEqual({
      ok: false,
      reason: 'reserved',
    });
    // A product cannot hand back a base label by omitting it.
    expect(checkSlug('mx', { reserved: ['nessie'] })).toEqual({
      ok: false,
      reason: 'reserved',
    });
  });
});

describe('deriveSlugBase — always produces something usable', () => {
  it('derives from an ordinary name', () => {
    expect(derive('Design')).toBe('design');
    expect(derive('Growth & Retention')).toBe('growth-retention');
  });

  it('falls back when a name carries nothing representable', () => {
    expect(derive('团队')).toBe('team');
    expect(derive('!!!')).toBe('team');
    expect(derive('')).toBe('team');
  });

  it('qualifies an all-numeric name instead of discarding the digits', () => {
    expect(derive('2026')).toBe('team-2026');
  });

  it('truncates to the DNS limit without leaving a trailing hyphen', () => {
    const derived = derive(`${'a'.repeat(62)} tail`);
    expect(derived.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(derived.endsWith('-')).toBe(false);
  });

  it('produces a label that always satisfies checkSlug except for reservation', () => {
    const names = ['团队', '!!!', '2026', 'a', '  --  ', 'Ünïcødé', 'x'.repeat(200)];
    for (const name of names) {
      const result = checkSlug(derive(name));
      if (!result.ok) expect(result.reason).toBe('reserved');
    }
  });

  it('can derive a label that is reserved — the caller must suffix it', () => {
    // Deliberate: a team genuinely named "API" derives to a reserved label, and
    // resolving that needs the table, so it is the resolver's job, not this
    // function's.
    expect(derive('API')).toBe('api');
    expect(isReservedLabel(derive('API'))).toBe(true);
  });
});

describe('withSlugSuffix', () => {
  it('appends within the label limit', () => {
    expect(withSlugSuffix('design', 'a1b2')).toBe('design-a1b2');
  });

  it('trims the base so the suffix always fits', () => {
    const out = withSlugSuffix('a'.repeat(SLUG_MAX_LENGTH), 'a1b2');
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(out.endsWith('-a1b2')).toBe(true);
  });

  it('never leaves a doubled hyphen where it trimmed', () => {
    expect(withSlugSuffix(`${'a'.repeat(57)}-`, 'a1b2')).not.toContain('--');
  });
});

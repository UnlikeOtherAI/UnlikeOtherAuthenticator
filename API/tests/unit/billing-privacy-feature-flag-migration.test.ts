import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260721183000_normalize_deepwater_privacy_flag/migration.sql',
  ),
  'utf8',
);

describe('DeepWater paid-privacy feature migration', () => {
  it('normalizes only the exact ungranted legacy flag and otherwise fails closed', () => {
    expect(migration).toContain('a."identifier" = \'deepwater-api\'');
    expect(migration).toContain('f."key" = \'can_be_private\'');
    expect(migration).toContain('DEEPWATER_PRIVACY_APP_AMBIGUOUS');
    expect(migration).toContain('DEEPWATER_PRIVACY_FLAG_DEFAULT_DRIFT');
    expect(migration).toContain('DEEPWATER_PRIVACY_LEGACY_OVERRIDES_PRESENT');
    expect(migration).toContain('DEEPWATER_PRIVACY_FLAG_DESCRIPTION_DRIFT');
    expect(migration).toContain('Allows paid private DeepWater research for an entitled team.');
  });
});

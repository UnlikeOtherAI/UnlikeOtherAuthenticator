import { describe, expect, it } from 'vitest';
import { settingVersion } from '../../src/services/setting-version.js';
describe('opaque settings version', () => {
  it('is stable across JSONB object ordering, but detects list edits and deletion', () => {
    expect(settingVersion({ a: 1, b: [{ c: true, d: 2 }] })).toBe(settingVersion({ b: [{ d: 2, c: true }], a: 1 }));
    expect(settingVersion([1, 2])).not.toBe(settingVersion([2, 1]));
    expect(settingVersion(null)).not.toBe(settingVersion([]));
  });
});

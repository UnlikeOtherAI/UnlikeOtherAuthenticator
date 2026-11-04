import { settingVersion } from './setting-version.js';

export type SettingsOperation =
  | { type: 'replace'; value: unknown }
  | { type: 'splice'; index: number; deleteCount: number; items: unknown[] };

/** One bounded root-array edit. Other JSON values deliberately replace whole. */
export function settingsDelta(before: unknown, after: unknown): SettingsOperation {
  const replacement: SettingsOperation = { type: 'replace', value: after };
  if (!Array.isArray(before) || !Array.isArray(after) || before.length + after.length > 20_000) return replacement;
  let first = 0;
  const equal = (a: unknown, b: unknown) => settingVersion(a) === settingVersion(b);
  while (first < before.length && first < after.length && equal(before[first], after[first])) first += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > first && newEnd > first && equal(before[oldEnd - 1], after[newEnd - 1])) {
    oldEnd -= 1; newEnd -= 1;
  }
  const splice: SettingsOperation = { type: 'splice', index: first, deleteCount: oldEnd - first, items: after.slice(first, newEnd) };
  return Buffer.byteLength(JSON.stringify(splice)) < Buffer.byteLength(JSON.stringify(replacement)) ? splice : replacement;
}

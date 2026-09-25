import { createHash } from 'node:crypto';

/** JSONB reorders object keys. Canonicalize objects, preserving array order. */
export function settingVersion(value: unknown): string {
  function canonical(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(canonical);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return node;
  }
  return '"' + createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') + '"';
}

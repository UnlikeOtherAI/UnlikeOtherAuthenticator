import { createHash } from 'node:crypto';
import type { ClientConfig } from './config.service.js';

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const serialized = canonicalJson(record[key]);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash the verified, parsed config semantics. JWT envelope fields such as iat,
 * exp, and signature bytes are absent from ClientConfig, while parsed defaults
 * and the database-backed redirect allow-list are included.
 */
export function fingerprintClientConfig(config: ClientConfig): string {
  return createHash('sha256')
    .update(canonicalJson(config) ?? '', 'utf8')
    .digest('hex');
}


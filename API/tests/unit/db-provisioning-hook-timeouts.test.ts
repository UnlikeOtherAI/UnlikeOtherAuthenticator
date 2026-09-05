import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `API/vitest.config.ts` gives every hook 180s because provisioning an isolated
 * schema shells out to `prisma migrate deploy`, which serialises on a
 * database-wide advisory lock. A per-hook timeout argument silently overrides
 * that budget, and one set to 30s made `refresh-token-replay-races` fail at
 * random on CI: `createTestDb` backs off for up to ~31s across its six startup
 * retries, so the hook could not even finish retrying before being killed.
 *
 * Provisioning hooks must therefore take their budget from the config.
 */
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const HOOK = /^(\s*)(beforeAll|beforeEach|afterAll|afterEach)\b/;
const CLOSED_WITH_TIMEOUT = /^(\s*)\}, *([0-9_]+)\);\s*$/;

function provisioningHooksWithOwnTimeout(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const offenders: string[] = [];

  lines.forEach((line, index) => {
    const closing = CLOSED_WITH_TIMEOUT.exec(line);
    if (!closing) return;

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const opening = HOOK.exec(lines[cursor]!);
      if (!opening || opening[1]!.length !== closing[1]!.length) continue;

      const body = lines.slice(cursor, index).join('\n');
      if (body.includes('createTestDb') || body.includes('createRlsTestDb')) {
        offenders.push(
          `${path.relative(testsDir, file)}:${cursor + 1} — ${opening[2]} sets ${closing[2]}ms`,
        );
      }
      return;
    }
  });

  return offenders;
}

describe('database-provisioning hooks', () => {
  it('take their timeout from vitest.config.ts, never their own argument', () => {
    const offenders = testFiles(testsDir).flatMap(provisioningHooksWithOwnTimeout);

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

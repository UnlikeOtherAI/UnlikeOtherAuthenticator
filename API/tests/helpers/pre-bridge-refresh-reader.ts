import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const preBridgeRefreshRevision = '0bd21cb71d9b429a0b521b9443a2354a68e5130d';
type Reader = Pick<typeof import('../../src/services/refresh-token.service.js'), 'exchangeRefreshToken' | 'revokeRefreshTokenFamily'>;

/** Execute the real pre-audit reader, rather than a rewritten equality model.
 * Only pinned repository source is extracted; no old server/build is started. */
export async function loadPreBridgeRefreshReader() {
  const apiRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const temporary = await mkdtemp(path.join(apiRoot, '.audit-reader-'));
  const cleanup = async () => {
    if (path.dirname(temporary) !== apiRoot || !path.basename(temporary).startsWith('.audit-reader-')) {
      throw new Error('Unexpected audit source archive location');
    }
    await rm(temporary, { recursive: true });
  };
  try {
    const archive = execFileSync('git', ['archive', preBridgeRefreshRevision, 'API/src'], {
      cwd: path.dirname(apiRoot), maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive });
    const reader = await import(pathToFileURL(path.join(temporary, 'API/src/services/refresh-token.service.ts')).href) as Reader;
    return { reader, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

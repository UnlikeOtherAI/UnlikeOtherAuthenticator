import { execFileSync } from 'node:child_process';

type Revision = {
  metadata?: { deletionTimestamp?: string };
  spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> };
  status?: { imageDigest?: string };
};

/** Phase two cannot run while ANY retained revision could be a legacy-only
 * reader, including zero-percent/tagged revisions. Operators remove retired
 * pre-bridge revisions only after their ordinary provider drain completes.
 * Image digests must be the operator's reviewed bridge/stable builds. */
export function assertWebsiteContextReaderFloor(revisions: unknown, approvedDigests: string[], requireStableWriters = false) {
  if (!Array.isArray(revisions) || !revisions.length || !approvedDigests.length ||
      approvedDigests.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) {
    throw new Error('Website context cutover requires a nonempty reviewed revision inventory');
  }
  for (const revision of revisions as Revision[]) {
    const modes = revision.spec?.containers?.[0]?.env?.filter(env => env.name === 'WEBSITE_CLIENT_CONTEXT_PHASE') ?? [];
    const mode = modes.length === 1 ? modes[0].value : undefined;
    const digest = revision.status?.imageDigest?.match(/sha256:[a-f0-9]{64}$/)?.[0];
    if (revision.metadata?.deletionTimestamp || !['bridge', 'stable'].includes(mode ?? '') ||
        (requireStableWriters && mode !== 'stable') ||
        !digest || !approvedDigests.includes(digest)) {
      throw new Error('Website context cutover refused: an unverified or retiring reader remains');
    }
  }
}

/** Capture provider inventory directly; a caller-supplied JSON assertion is not
 * a cutover permit. Never log raw provider output (container env may be secret). */
export function verifyCloudRunWebsiteContextReaderFloor(input: {
  project: string; region: string; service: string; approvedDigests: string[];
}) {
  if (![input.project, input.region, input.service].every(value => /^[a-z][a-z0-9-]{0,62}$/.test(value))) {
    throw new Error('Explicit Cloud Run project, region and service are required');
  }
  let revisions: unknown;
  try {
    revisions = JSON.parse(execFileSync('gcloud', ['run', 'revisions', 'list',
      `--project=${input.project}`, `--region=${input.region}`, `--service=${input.service}`,
      '--format=json', '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  } catch { throw new Error('Cannot verify Cloud Run reader floor; no context conversion permitted'); }
  assertWebsiteContextReaderFloor(revisions, input.approvedDigests, true);
}

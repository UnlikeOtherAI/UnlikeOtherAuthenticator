import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Execute the ACTUAL Actions run block with a provider stub. Local Linux/CI:
// node tests/helpers/check-website-context-deploy-floor.mjs
// Windows: append --ssh-host=fedora-maxis; only bash/jq run there, no files/builds.
const workflow = readFileSync(new URL('../../../.github/workflows/deploy-main.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('      - name: Verify website context reader floor before stable deployment');
const end = workflow.indexOf('      - name: Log in to Artifact Registry', start);
if (start < 0 || end < 0) throw new Error('Stable deployment gate is missing');
const block = workflow.slice(start, end).split(/\r?\n/);
const run = block.findIndex(line => line.trim() === 'run: |');
if (run < 0) throw new Error('Stable deployment gate has no executable run block');
const script = block.slice(run + 1).map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const digest = 'sha256:' + '1'.repeat(64);
function revision(mode = 'bridge', image = digest) {
  return { spec: { containers: [{ env: mode ? [{ name: 'WEBSITE_CLIENT_CONTEXT_PHASE', value: mode }] : [] }] },
    status: { imageDigest: 'registry.example.com/api@' + image } };
}
const fixtures = [
  { name: 'reviewed bridge reader', inventory: [revision()], expected: 0 },
  { name: 'reviewed stable reader', inventory: [revision('stable')], expected: 0 },
  { name: 'empty inventory', inventory: [], expected: 1 },
  { name: 'legacy reader', inventory: [revision(null)], expected: 1 },
  { name: 'unknown image', inventory: [revision('bridge', 'sha256:' + '2'.repeat(64))], expected: 1 },
  { name: 'retiring reader', inventory: [{ ...revision(), metadata: { deletionTimestamp: '2026-10-14' } }], expected: 1 },
  { name: 'unreviewed zero-traffic reader', inventory: [revision(), revision(null)], expected: 1 },
  { name: 'duplicate phase metadata', inventory: [{ ...revision(), spec: { containers: [{ env: [
    { name: 'WEBSITE_CLIENT_CONTEXT_PHASE', value: 'bridge' }, { name: 'WEBSITE_CLIENT_CONTEXT_PHASE', value: 'stable' },
  ] }] } }], expected: 1 },
  { name: 'missing reviewed digests', inventory: [revision()], approved: '', expected: 1 },
  { name: 'provider unavailable', inventory: [revision()], providerExit: 17, expected: 17 },
];
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const remote = process.argv.find(value => value.startsWith('--ssh-host='))?.slice('--ssh-host='.length);
if (remote && !/^[a-zA-Z0-9._-]+$/.test(remote)) throw new Error('Invalid test SSH host');
let failures = 0;
for (const fixture of fixtures) {
  const prelude = `export WEBSITE_CLIENT_CONTEXT_COMPATIBLE_IMAGE_DIGESTS=${quote(fixture.approved ?? digest)}
export GCP_PROJECT_ID=fixture-project GCP_REGION=fixture-region GCP_CLOUD_RUN_SERVICE=fixture-service
gcloud() {
  test "$*" = 'run revisions list --project=fixture-project --region=fixture-region --service=fixture-service --format=json --quiet' || return 99
  if test ${fixture.providerExit ?? 0} -ne 0; then return ${fixture.providerExit ?? 0}; fi
  printf '%s' ${quote(JSON.stringify(fixture.inventory))}
}
readonly -f gcloud
`;
  const result = spawnSync(remote ? 'ssh' : 'bash', remote
    ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', remote, 'bash', '-s'] : ['-s'],
  { input: prelude + script, encoding: 'utf8', timeout: 15_000 });
  const pass = result.status === fixture.expected && !result.error;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${fixture.name}: exit=${result.status}, expected=${fixture.expected}`);
  if (!pass) failures++;
}
if (failures) process.exitCode = 1;

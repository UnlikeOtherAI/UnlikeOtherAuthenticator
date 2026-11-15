import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../../.github/workflows/deploy-main.yml', import.meta.url);
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const expectedImage = `registry.example/uoa@sha256:${'a'.repeat(64)}`;
function step(workflow: string, name: string): string {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  const command = body?.split('        run: |\n')[1];
  if (!command) throw new Error(`Missing workflow step: ${name}`);
  return command.split('\n').map(line => line.slice(10)).join('\n')
    .replaceAll('${{ steps.deploy.outputs.revision }}', '${DEPLOYED_REVISION}');
}

async function rollout(scenario: string) {
  const workflow = (await readFile(workflowUrl, 'utf8')).replaceAll('\r\n', '\n');
  const directory = await mkdtemp(join(process.cwd(), '.cloud-route-workflow-'));
  const file = join(directory, 'rollout.sh');
  const trace = join(directory, 'trace').replaceAll('\\', '/');
  const output = join(directory, 'output').replaceAll('\\', '/');
  const stub = `
gcloud() {
  printf '%s\\n' "$*" >> "$TRACE"
  case "$1 $2 $3" in
    'run deploy test-service')
      # The incident: synchronous deploy waits on the old failed route.
      [[ " $* " == *' --async '* ]] || return 42
      [[ "$SCENARIO" != 'submission_failure' ]] || return 13
      ;;
    'artifacts docker images') printf '%s\\n' "$EXPECTED_IMAGE" ;;
    'run revisions describe')
      count=$(cat "$TRACE.count" 2>/dev/null || printf 0)
      count=$((count+1)); printf '%s' "$count" > "$TRACE.count"
      [[ "$SCENARIO" != 'not_found_once' || "$count" != 1 ]] || return 1
      case "$SCENARIO" in
        wrong_image) printf '%s\\n' '{"status":{"imageDigest":"other@sha256:bad","conditions":[{"type":"Ready","status":"True"}]}}' ;;
        candidate_failed) printf '%s\\n' '{"status":{"conditions":[{"type":"Ready","status":"False"}]}}' ;;
        never_ready) printf '%s\\n' '{"status":{"conditions":[{"type":"Ready","status":"Unknown"}]}}' ;;
        *) printf '{"status":{"imageDigest":"%s","conditions":[{"type":"Ready","status":"True"}]}}\\n' "$EXPECTED_IMAGE" ;;
      esac
      ;;
    'run services update-traffic') [[ "$SCENARIO" != 'startup_failure' ]] || return 14 ;;
    'run services describe')
      if [[ "$SCENARIO" == 'wrong_serving_revision' ]]; then printf 'old-revision\\n';
      else printf '%s\\n' "$DEPLOYED_REVISION"; fi
      ;;
    *) return 99 ;;
  esac
}
sleep() { printf 'sleep %s\\n' "$*" >> "$TRACE"; }
`;
  await writeFile(file, `${stub}\n(\n${step(workflow, 'Deploy to Cloud Run')}\n)\n(\n${step(workflow, 'Verify candidate revision')}\n)\n(\n${step(workflow, 'Promote deployed revision')}\n)\nprintf 'rollout-verified\\n'`);
  try {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', file.replaceAll('\\', '/')], {
      encoding: 'utf8', timeout: 30_000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        SCENARIO: scenario, EXPECTED_IMAGE: expectedImage, TRACE: trace, GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '2', DEPLOYED_REVISION: 'test-service-r101-2',
        GCP_CLOUD_RUN_SERVICE: 'test-service', GCP_PROJECT_ID: 'test-project', GCP_REGION: 'europe-west1',
        IMAGE: 'registry.example/uoa:merged-sha' },
    });
    if (result.error) throw result.error;
    return { ...result, trace: await readFile(trace, 'utf8'), output: await readFile(output, 'utf8').catch(() => '') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('Cloud Run recovery from a failed older desired route', () => {
  it.each(['old_route_failed', 'not_found_once'])('promotes only the verified new revision (%s)', async scenario => {
    const result = await rollout(scenario);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.output.trim()).toBe('revision=test-service-r101-2');
    expect(result.trace).toContain('--revision-suffix r101-2 --async');
    expect(result.trace).toContain('run revisions describe test-service-r101-2');
    expect(result.trace).toContain('--to-revisions test-service-r101-2=100');
    expect(result.trace).not.toContain('latestCreatedRevisionName');
    expect(result.stdout).toContain('rollout-verified');
  });

  it.each(['submission_failure', 'wrong_image', 'candidate_failed', 'never_ready'])('does not promote after %s', async scenario => {
    const result = await rollout(scenario);
    expect(result.status).not.toBe(0);
    expect(result.trace).not.toContain('update-traffic');
    expect(result.stdout).not.toContain('rollout-verified');
    if (scenario === 'never_ready') expect(result.trace.match(/run revisions describe/g)).toHaveLength(30);
  });

  it.each(['startup_failure', 'wrong_serving_revision'])('does not report readiness after %s', async scenario => {
    const result = await rollout(scenario);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('rollout-verified');
  });
});

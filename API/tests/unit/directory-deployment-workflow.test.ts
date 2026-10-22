import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../../.github/workflows/deploy-main.yml', import.meta.url);
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
function step(workflow: string, name: string): string {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  if (!body?.includes('        run: |\n')) throw new Error(`Missing executable workflow step: ${name}`);
  return body.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
}
async function deploy(configured: string) {
  const workflow = (await readFile(workflowUrl, 'utf8')).replaceAll('\r\n', '\n');
  const validation = step(workflow, 'Validate directory webhook deployment configuration');
  const command = step(workflow, 'Deploy to Cloud Run');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-c',
    `${validation}\ngcloud() { printf '%s\\0' "$@"; exit 0; }\n${command}`], {
    encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      UOA_DIRECTORY_WEBHOOKS_CONFIGURED: configured, UOA_ENTERPRISE_SSO_CONFIGURED: 'false',
      STRIPE_BILLING_ENABLED: 'false', UOA_STRIPE_BILLING_CONFIGURED: 'false', UOA_SMS_CONFIGURED: 'false',
      GCP_CLOUD_RUN_SERVICE: 'test-service', GCP_PROJECT_ID: 'test-project', GCP_REGION: 'europe-west1', IMAGE: 'test-image' },
  });
  if (result.error) throw result.error;
  return { ...result, args: result.stdout.split('\0'), workflow };
}

describe('directory delivery in the actual Cloud Run deployment shell', () => {
  it('binds the private Secret Manager target list and keeps outbox delivery running while other features are off', async () => {
    const result = await deploy('true');
    expect(result.status).toBe(0);
    expect(result.args.slice(0, 3)).toEqual(['run', 'deploy', 'test-service']);
    expect(result.args[result.args.indexOf('--set-secrets') + 1]!.split(','))
      .toContain('DIRECTORY_WEBHOOK_TARGETS_JSON=uoa-auth-directory-webhook-targets-json:latest');
    expect(result.args[result.args.indexOf('--set-env-vars') + 1]).not.toContain('DIRECTORY_WEBHOOK_TARGETS_JSON');
    expect(result.args[result.args.indexOf('--min-instances') + 1]).toBe('1');
    expect(result.args).toContain('--no-cpu-throttling');
  });

  it('defaults existing deployments to no target secret and preserves scale-to-zero', async () => {
    const result = await deploy('false');
    expect(result.status).toBe(0);
    expect(result.workflow).toContain("UOA_DIRECTORY_WEBHOOKS_CONFIGURED: ${{ vars.UOA_DIRECTORY_WEBHOOKS_CONFIGURED || 'false' }}");
    expect(result.args[result.args.indexOf('--set-secrets') + 1]).not.toContain('DIRECTORY_WEBHOOK_TARGETS_JSON');
    expect(result.args[result.args.indexOf('--min-instances') + 1]).toBe('0');
    expect(result.args).toContain('--cpu-throttling');
  });

  it.each(['TRUE', '1', 'true,INJECTED=value'])('rejects invalid activation before a cloud command (%s)', async flag => {
    const result = await deploy(flag);
    expect(result.status).not.toBe(0);
    expect(result.args).not.toContain('--set-secrets');
  });
});

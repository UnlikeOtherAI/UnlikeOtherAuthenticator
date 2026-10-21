import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../../.github/workflows/deploy-main.yml', import.meta.url);
const key = 'projects/test-project/locations/europe-west1/keyRings/enterprise/cryptoKeys/wrapping';
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';

function step(workflow: string, name: string) {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  if (!body?.includes('        run: |\n')) throw new Error(`Missing executable workflow step: ${name}`);
  return body.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
}

async function deploy(configured: string, wrappingKey: string) {
  const workflow = (await readFile(workflowUrl, 'utf8')).replaceAll('\r\n', '\n');
  const validation = step(workflow, 'Validate enterprise SSO deployment configuration');
  const command = step(workflow, 'Deploy to Cloud Run');
  // Execute the actual deployment shell. Its first gcloud call is captured and
  // ends the shell, so no cloud command, promotion or credentials are involved.
  const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-c',
    `${validation}\ngcloud() { printf '%s\\0' "$@"; exit 0; }\n${command}`], {
    encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      UOA_ENTERPRISE_SSO_CONFIGURED: configured, ENTERPRISE_SSO_KMS_KEY: wrappingKey,
      STRIPE_BILLING_ENABLED: 'false', UOA_STRIPE_BILLING_CONFIGURED: 'false', UOA_SMS_CONFIGURED: 'false',
      GCP_CLOUD_RUN_SERVICE: 'test-service', GCP_PROJECT_ID: 'test-project', GCP_REGION: 'europe-west1', IMAGE: 'test-image' },
  });
  if (result.error) throw result.error;
  return { ...result, args: result.stdout.split('\0') };
}

describe('enterprise custody in the actual Cloud Run deployment shell', () => {
  it('binds dedicated KMS custody and keeps revocation work running while Stripe is off', async () => {
    const result = await deploy('true', key);
    expect(result.status).toBe(0);
    expect(result.args.slice(0, 3)).toEqual(['run', 'deploy', 'test-service']);
    expect(result.args[result.args.indexOf('--min-instances') + 1]).toBe('1');
    expect(result.args).toContain('--no-cpu-throttling');
    const env = result.args[result.args.indexOf('--set-env-vars') + 1]!;
    expect(env.split(',')).toContain('ENTERPRISE_SSO_CUSTODY_PROVIDER=gcp_kms');
    expect(env.split(',')).toContain(`ENTERPRISE_SSO_KMS_KEY=${key}`);
    expect(env).not.toContain('ENTERPRISE_SSO_KEYRING=');
  });

  it('retains the existing scale-to-zero deployment when enterprise custody is unconfigured', async () => {
    const result = await deploy('false', '');
    expect(result.status).toBe(0);
    expect(result.args[result.args.indexOf('--min-instances') + 1]).toBe('0');
    expect(result.args).toContain('--cpu-throttling');
    expect(result.args[result.args.indexOf('--set-env-vars') + 1]).not.toContain('ENTERPRISE_SSO_');
  });

  it.each([['TRUE', key], ['true', ''], ['true', 'projects/test,INJECTED=true'], ['false', key]])(
    'refuses invalid or inconsistent enterprise configuration before calling gcloud (%s)', async (flag, resource) => {
      const result = await deploy(flag, resource);
      expect(result.status).not.toBe(0);
      expect(result.args).not.toContain('--set-env-vars');
    },
  );
});

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const workflowUrl = new URL('../../../.github/workflows/deploy-main.yml', import.meta.url);
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
function step(workflow: string, name: string) {
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  const command = body?.split('        run: |\n')[1];
  if (!command) throw new Error(`Missing executable workflow step: ${name}`);
  return command.split('\n').map(line => line.slice(10)).join('\n');
}
async function deploy(overrides: Record<string, string> = {}) {
  const workflow = (await readFile(workflowUrl, 'utf8')).replaceAll('\r\n', '\n');
  const directory = mkdtempSync(join(process.cwd(), '.billing-mode-workflow-'));
  const file = join(directory, 'preflight.sh');
  writeFileSync(file, `${step(workflow, 'Validate billing deployment configuration')}\ngcloud() { printf '%s\\0' "$@"; exit 0; }\n${step(workflow, 'Deploy to Cloud Run')}`);
  try {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-e', file.replaceAll('\\', '/')], {
    encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      STRIPE_BILLING_ENABLED: 'false', UOA_STRIPE_BILLING_CONFIGURED: 'true',
      UOA_STRIPE_LIVE_CONFIGURED: 'false', UOA_STRIPE_SANDBOX_CONFIGURED: 'false',
      STRIPE_LIVE_ACCOUNT_ID: '', STRIPE_SANDBOX_ACCOUNT_ID: '', UOA_SMS_CONFIGURED: 'false',
      BILLING_SMS_ENABLED: 'false', BILLING_SMS_POLICY_AUTORENEW_ENABLED: 'false',
      BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS: '500', BILLING_SMS_POLICY_AUTORENEW_LOOKAHEAD_DAYS: '7',
      BILLING_SMS_TWILIO_REGION: 'us1', BILLING_CREDIT_FX_RATE_SOURCE: 'stripe',
      UOA_SMS_PRICING_MODE: 'legacy', BILLING_INVOICE_STORAGE_PROVIDER: 'disabled',
      STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES: '1', LEDGER_BILLING_BASE_URL: 'https://ledger.example.test',
      LEDGER_BILLING_APP_KEY_ID: 'test-key', LEDGER_BILLING_ASSERTION_AUDIENCE: 'https://ledger.example.test',
      GCP_CLOUD_RUN_SERVICE: 'test-service', GCP_PROJECT_ID: 'test-project', GCP_REGION: 'europe-west1',
      IMAGE: 'test-image', ...overrides },
  });
  if (result.error) throw result.error;
  return { ...result, args: result.stdout.split('\0') };
  } finally { unlinkSync(file); rmdirSync(directory); }
}
describe('coordinated dual-mode deployment preflight', () => {
  it('refuses the existing enabled legacy-only configuration before deployment', async () => {
    const result = await deploy({ STRIPE_BILLING_ENABLED: 'true' });
    expect(result.status).not.toBe(0); expect(result.stdout).toContain('Dual-mode billing requires');
    expect(result.args).not.toContain('deploy');
  });
  it.each(['', 'acct_main,INJECTED=true'])('refuses an invalid named binding even with collection disabled (%s)', async account => {
    const result = await deploy({ UOA_STRIPE_LIVE_CONFIGURED: 'true', STRIPE_LIVE_ACCOUNT_ID: account });
    expect(result.status).not.toBe(0); expect(result.args).not.toContain('deploy');
  });
  it('keeps legacy-only auth deployment possible when billing is disabled', async () => {
    const result = await deploy(); expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.args).toContain('deploy');
    expect(result.args[result.args.indexOf('--set-secrets') + 1]).toContain('STRIPE_SECRET_KEY=uoa-auth-stripe-secret-key:latest');
  });
  it('binds both explicit tuples to reviewed version 1 and preserves legacy references', async () => {
    const result = await deploy({ STRIPE_BILLING_ENABLED: 'true', UOA_STRIPE_LIVE_CONFIGURED: 'true',
      UOA_STRIPE_SANDBOX_CONFIGURED: 'true', STRIPE_LIVE_ACCOUNT_ID: 'acct_main', STRIPE_SANDBOX_ACCOUNT_ID: 'acct_main' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const secrets = result.args[result.args.indexOf('--set-secrets') + 1]?.split(',');
    for (const [mode, slot] of [['LIVE', 'live'], ['SANDBOX', 'sandbox']]) {
      expect(secrets).toContain(`STRIPE_${mode}_SECRET_KEY=uoa-auth-stripe-${slot}-secret-key:1`);
      expect(secrets).toContain(`STRIPE_${mode}_WEBHOOK_SECRET=uoa-auth-stripe-${slot}-webhook-secret:1`);
      expect(result.args[result.args.indexOf('--set-env-vars') + 1]).toContain(`STRIPE_${mode}_ACCOUNT_ID=acct_main`);
    }
    expect(secrets).toContain('STRIPE_WEBHOOK_SECRET=uoa-auth-stripe-webhook-secret:latest');
  });
});

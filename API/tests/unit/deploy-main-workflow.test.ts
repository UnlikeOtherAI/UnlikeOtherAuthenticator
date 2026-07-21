import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../../.github/workflows/deploy-main.yml', import.meta.url);

describe('main deployment workflow billing runtime', () => {
  it('forwards the bounded automatic top-up cadence to Cloud Run', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');

    expect(workflow).toContain(
      "STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES: ${{ vars.STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES || '1' }}",
    );
    expect(workflow).toContain(
      'STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES=$STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES',
    );
    expect(workflow).toContain(
      'STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES must be an integer from 1 to 60',
    );
  });

  it('allows only disabled or fully configured GCS invoice storage', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');

    expect(workflow).toContain('disabled|gcs) ;;');
    expect(workflow).toContain(
      'BILLING_INVOICE_GCS_BUCKET is required when invoice storage uses gcs',
    );
    expect(workflow).toContain(
      'BILLING_INVOICE_STORAGE_PROVIDER=$BILLING_INVOICE_STORAGE_PROVIDER',
    );
    expect(workflow).toContain('BILLING_INVOICE_GCS_BUCKET=$BILLING_INVOICE_GCS_BUCKET');
    expect(workflow).toContain('BILLING_INVOICE_GCS_PROJECT_ID=$BILLING_INVOICE_GCS_PROJECT_ID');
  });
});

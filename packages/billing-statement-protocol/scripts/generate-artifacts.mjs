import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billingCreditBudgetV1ConformanceFixture,
  billingCreditBudgetV1JsonSchema,
  billingCreditBudgetV1OpenApiDocument,
  billingCustomerInvoicesProtocolV1JsonSchema,
  billingCustomerInvoicesListV1ConformanceFixture,
  billingCustomerInvoiceDetailV1ConformanceFixture,
  billingCustomerInvoicePendingDetailV1ConformanceFixture,
  billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
  billingCustomerInvoicesV1OpenApiDocument,
  billingCyclesProtocolV2JsonSchema,
  billingCyclesListV2ConformanceFixture,
  billingCycleDetailV2ConformanceFixture,
  billingCycleDownloadRequestV2ConformanceFixture,
  billingCyclesV2OpenApiDocument,
  billingConsumerActionProtocolV1JsonSchema,
  billingConsumerActionV1ConformanceFixtures,
  billingConsumerActionV1OpenApiDocument,
  billingRecurringAddonProtocolV1JsonSchema,
  billingRecurringAddonV1ConformanceFixtures,
  billingRecurringAddonV1OpenApiDocument,
  billingStatementV1ConformanceFixture,
  billingStatementV1JsonSchema,
  billingStatementV1OpenApiDocument,
  billingStatementV2ConformanceFixture,
  billingStatementV2JsonSchema,
  billingStatementV2OpenApiDocument,
  billingCreditsV1ConformanceFixture,
  billingCreditsV1JsonSchema,
  billingCreditsV1OpenApiDocument,
  billingCreditPurchaseStatusV1JsonSchema,
  billingCreditFundingRequestV1JsonSchema,
} from '../dist/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = new Map([
  [resolve(packageRoot, 'schema/billing-credit-funding-request-v1.json'), billingCreditFundingRequestV1JsonSchema],
  [resolve(packageRoot, 'schema/billing-credit-purchase-status-v1.json'), billingCreditPurchaseStatusV1JsonSchema],
  [resolve(packageRoot, 'schema/billing-customer-invoices-v1.json'), billingCustomerInvoicesProtocolV1JsonSchema],
  [resolve(packageRoot, 'fixtures/billing-customer-invoices-v1.example.json'), {
    list: billingCustomerInvoicesListV1ConformanceFixture,
    detail: billingCustomerInvoiceDetailV1ConformanceFixture,
    pending_detail: billingCustomerInvoicePendingDetailV1ConformanceFixture,
    download_request: billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
  }],
  [resolve(packageRoot, 'openapi/billing-customer-invoices-v1.openapi.json'), billingCustomerInvoicesV1OpenApiDocument],
  [resolve(packageRoot, 'schema/billing-credit-budgets-v1.json'), billingCreditBudgetV1JsonSchema],
  [resolve(packageRoot, 'fixtures/billing-credit-budgets-v1.example.json'), billingCreditBudgetV1ConformanceFixture],
  [resolve(packageRoot, 'openapi/billing-credit-budgets-v1.openapi.json'), billingCreditBudgetV1OpenApiDocument],
  [resolve(packageRoot, 'schema/billing-cycles-v2.json'), billingCyclesProtocolV2JsonSchema],
  [resolve(packageRoot, 'fixtures/billing-cycles-v2.example.json'), { list: billingCyclesListV2ConformanceFixture, detail: billingCycleDetailV2ConformanceFixture, download_request: billingCycleDownloadRequestV2ConformanceFixture }],
  [resolve(packageRoot, 'openapi/billing-cycles-v2.openapi.json'), billingCyclesV2OpenApiDocument],
  [resolve(packageRoot, 'schema/billing-credits-v1.json'), billingCreditsV1JsonSchema],
  [
    resolve(packageRoot, 'fixtures/billing-credits-v1.example.json'),
    billingCreditsV1ConformanceFixture,
  ],
  [
    resolve(packageRoot, 'openapi/billing-credits-v1.openapi.json'),
    billingCreditsV1OpenApiDocument,
  ],
  [
    resolve(packageRoot, 'schema/billing-recurring-addons-v1.json'),
    billingRecurringAddonProtocolV1JsonSchema,
  ],
  [
    resolve(packageRoot, 'fixtures/billing-recurring-addons-v1.example.json'),
    billingRecurringAddonV1ConformanceFixtures,
  ],
  [
    resolve(packageRoot, 'openapi/billing-recurring-addons-v1.openapi.json'),
    billingRecurringAddonV1OpenApiDocument,
  ],
  [
    resolve(packageRoot, 'schema/billing-consumer-actions-v1.json'),
    billingConsumerActionProtocolV1JsonSchema,
  ],
  [
    resolve(packageRoot, 'fixtures/billing-consumer-actions-v1.example.json'),
    billingConsumerActionV1ConformanceFixtures,
  ],
  [
    resolve(packageRoot, 'openapi/billing-consumer-actions-v1.openapi.json'),
    billingConsumerActionV1OpenApiDocument,
  ],
  [resolve(packageRoot, 'schema/billing-statement-v1.json'), billingStatementV1JsonSchema],
  [
    resolve(packageRoot, 'fixtures/billing-statement-v1.example.json'),
    billingStatementV1ConformanceFixture,
  ],
  [
    resolve(packageRoot, 'openapi/billing-statement-v1.openapi.json'),
    billingStatementV1OpenApiDocument,
  ],
  [resolve(packageRoot, 'schema/billing-statement-v2.json'), billingStatementV2JsonSchema],
  [
    resolve(packageRoot, 'fixtures/billing-statement-v2.example.json'),
    billingStatementV2ConformanceFixture,
  ],
  [
    resolve(packageRoot, 'openapi/billing-statement-v2.openapi.json'),
    billingStatementV2OpenApiDocument,
  ],
]);
const mode = process.argv[2];

if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: generate-artifacts.mjs --write|--check');
}

for (const [path, value] of artifacts) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (mode === '--write') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected, 'utf8');
    continue;
  }
  const actual = await readFile(path, 'utf8').catch(() => '');
  if (actual !== expected) {
    throw new Error(
      `${path} has drifted from the TypeScript source. Run pnpm --filter @unlikeotherai/billing-statement-protocol generate.`,
    );
  }
}

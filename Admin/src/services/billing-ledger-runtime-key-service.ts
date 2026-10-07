import {
  BillingLedgerRuntimeKeyFormSchema,
  BillingLedgerRuntimeKeysSchema,
  CreatedBillingLedgerRuntimeKeySchema,
  RevokedBillingLedgerRuntimeKeySchema,
  type BillingLedgerRuntimeKeyFormValues,
} from '../schemas/billing-ledger-runtime-keys';
import { createApiClient } from './api-client';

const api = createApiClient();
const path = '/internal/admin/billing/ledger-runtime-keys';

export const billingLedgerRuntimeKeyService = {
  async list() {
    return BillingLedgerRuntimeKeysSchema.parse(await api.get<unknown>(path, {
      cache: 'no-store',
    })).keys;
  },
  async create(product: string, input: BillingLedgerRuntimeKeyFormValues) {
    const values = BillingLedgerRuntimeKeyFormSchema.parse(input);
    return CreatedBillingLedgerRuntimeKeySchema.parse(await api.post<unknown>(path, {
      product, source_domain: values.sourceDomain.toLowerCase(),
      ledger_audience: values.ledgerAudience,
    }, { cache: 'no-store' }));
  },
  async revoke(id: string) {
    return RevokedBillingLedgerRuntimeKeySchema.parse(await api.post<unknown>(
      `${path}/${encodeURIComponent(id)}/revoke`, undefined, { cache: 'no-store' },
    ));
  },
};

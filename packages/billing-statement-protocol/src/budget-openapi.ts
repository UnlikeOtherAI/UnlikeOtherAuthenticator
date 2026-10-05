import { billingCreditBudgetV1JsonSchema, billingCreditBudgetWriteV1JsonSchema,
  billingCreditBudgetDeleteV1JsonSchema } from './budget-schema.js';
import { BILLING_CREDIT_BUDGET_PROTOCOL_VERSION } from './budget-types.js';

export const billingCreditBudgetV1OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'UOA customer credit budgets', version: BILLING_CREDIT_BUDGET_PROTOCOL_VERSION },
  components: {
    schemas: {
      BillingCreditBudgetListV1: billingCreditBudgetV1JsonSchema,
      BillingCreditBudgetWriteV1: billingCreditBudgetWriteV1JsonSchema,
      BillingCreditBudgetDeleteV1: billingCreditBudgetDeleteV1JsonSchema,
    },
  },
} as const;

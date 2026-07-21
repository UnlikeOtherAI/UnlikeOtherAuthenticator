import { billingSubjectActionBodySchema } from './funding-schema-primitives.js';
import {
  BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  BILLING_CREDITS_TOP_UP_PATH,
} from './credits-types.js';

const actionBaseProperties = {
  label: { type: 'string' },
  description: { type: 'string' },
  enabled: { type: 'boolean' },
  disabled_reason: { type: ['string', 'null'] },
} as const;

const actionBaseRequired = [
  'id',
  'kind',
  'label',
  'description',
  'enabled',
  'disabled_reason',
  'request',
] as const;

function actionRequestSchema(path: string, selector: 'offer_id' | 'option_id' | null) {
  const body = selector
    ? billingSubjectActionBodySchema({ [selector]: { type: 'string', minLength: 1 } }, [selector])
    : billingSubjectActionBodySchema();
  return {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'path', 'body'],
    properties: {
      method: { const: 'POST' },
      path: { const: path },
      body,
    },
  } as const;
}

function actionSchema(
  id: string,
  kind: 'hosted_redirect' | 'mutation',
  path: string,
  selector: 'offer_id' | 'option_id' | null,
) {
  return {
    type: 'object',
    additionalProperties: false,
    required: actionBaseRequired,
    properties: {
      id: { const: id },
      kind: { const: kind },
      ...actionBaseProperties,
      request: actionRequestSchema(path, selector),
    },
  } as const;
}

export const billingCreditsTopUpActionJsonSchema = actionSchema(
  'top_up',
  'hosted_redirect',
  BILLING_CREDITS_TOP_UP_PATH,
  'offer_id',
);
export const billingCreditsAutoTopUpSetupActionJsonSchema = actionSchema(
  'auto_top_up_setup',
  'hosted_redirect',
  BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
  'option_id',
);
export const billingCreditsAutoTopUpUpdateActionJsonSchema = actionSchema(
  'auto_top_up_update',
  'mutation',
  BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  'option_id',
);
export const billingCreditsAutoTopUpDisableActionJsonSchema = actionSchema(
  'auto_top_up_disable',
  'mutation',
  BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
  null,
);
export const billingCreditsAutoTopUpRecoverActionJsonSchema = actionSchema(
  'auto_top_up_recover',
  'hosted_redirect',
  BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  null,
);

export const nullableBillingCreditsAction = (schema: ReturnType<typeof actionSchema>) => ({
  oneOf: [schema, { type: 'null' }],
});

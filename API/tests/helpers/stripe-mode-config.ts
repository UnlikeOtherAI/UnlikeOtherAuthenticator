import { vi } from 'vitest';

/** Synthetic named slot only. Callers inject their Stripe transport; these
 * deliberately unusable keys are never credentials or provider write authority. */
export function configureSyntheticStripeMode(accountId:string,livemode:boolean) {
  const slot=livemode?'LIVE':'SANDBOX';
  vi.stubEnv(`STRIPE_${slot}_ACCOUNT_ID`,accountId);
  vi.stubEnv(`STRIPE_${slot}_SECRET_KEY`,`sk_${livemode?'live':'test'}_synthetic_unusable`);
  vi.stubEnv(`STRIPE_${slot}_WEBHOOK_SECRET`,'whsec_synthetic_unusable');
}

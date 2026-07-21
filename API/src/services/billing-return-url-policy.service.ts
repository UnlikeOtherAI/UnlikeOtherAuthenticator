import { AppError } from '../utils/errors.js';

export type PinnedBillingReturnUrls = {
  checkoutSuccess: string;
  checkoutCancel: string;
  portal: string;
};

export function pinnedBillingReturnUrls(origins: string[]): PinnedBillingReturnUrls {
  const origin = origins[0];
  if (!origin) throw new AppError('INTERNAL', 500, 'BILLING_RETURN_URL_UNSET');
  const portal = new URL('/', origin);
  const success = new URL(portal);
  success.searchParams.set('uoa_billing', 'checkout_complete');
  const cancel = new URL(portal);
  cancel.searchParams.set('uoa_billing', 'checkout_cancelled');
  return {
    checkoutSuccess: success.toString(),
    checkoutCancel: cancel.toString(),
    portal: portal.toString(),
  };
}

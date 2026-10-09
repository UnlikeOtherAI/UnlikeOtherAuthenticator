import { AppError } from '../utils/errors.js';

export interface SmsCommercialPolicy {
  version: string;
  monthlyFeeEur: string;
  messageMarkupBps: number;
}

/** Private deployment policy. No commercial defaults belong in the public repository. */
export function readSmsCommercialPolicy(): SmsCommercialPolicy {
  const version = process.env.UOA_SMS_COMMERCIAL_POLICY_VERSION;
  const monthlyFeeEur = process.env.UOA_SMS_MONTHLY_FEE_EUR;
  const markup = process.env.UOA_SMS_MESSAGE_MARKUP_BPS;
  if (!version || !/^[A-Za-z0-9_-]{1,80}$/.test(version) ||
      !monthlyFeeEur || !/^(0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(monthlyFeeEur) ||
      !markup || !/^(0|[1-9]\d{0,5})$/.test(markup)) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
  }
  return { version, monthlyFeeEur, messageMarkupBps: Number(markup) };
}

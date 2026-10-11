import { AppError } from '../utils/errors.js';

export interface SmsCommercialPolicy {
  version: string;
  monthlyFeeEur: string;
  monthlyMarkupBps: number;
  messageMarkupBps: number;
}

/** Private deployment policy. No commercial defaults belong in the public repository. */
export function readSmsCommercialPolicy(): SmsCommercialPolicy {
  const version = process.env.UOA_SMS_COMMERCIAL_POLICY_VERSION;
  if (!version || !/^[A-Za-z0-9_-]{1,80}$/.test(version)) throw required();
  const mode = process.env.UOA_SMS_PRICING_MODE ?? 'legacy';
  if (mode === 'provider_markup') {
    const markup = process.env.UOA_SMS_PROVIDER_MARKUP_BPS;
    if (!validMarkup(markup)) throw required();
    return { version, monthlyFeeEur: '0', monthlyMarkupBps: Number(markup), messageMarkupBps: Number(markup) };
  }
  if (mode !== 'legacy') throw required();
  const monthlyFeeEur = process.env.UOA_SMS_MONTHLY_FEE_EUR;
  const markup = process.env.UOA_SMS_MESSAGE_MARKUP_BPS;
  if (!monthlyFeeEur || !/^(0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(monthlyFeeEur) || !validMarkup(markup)) {
    throw required();
  }
  return { version, monthlyFeeEur, monthlyMarkupBps: 0, messageMarkupBps: Number(markup) };
}

function validMarkup(value: string | undefined): boolean {
  return value !== undefined && /^(0|[1-9]\d{0,5})$/.test(value);
}
function required(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
}

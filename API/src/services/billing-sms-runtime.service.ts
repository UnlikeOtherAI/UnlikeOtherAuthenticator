import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { BillingSmsProvider } from './billing-sms-provider.service.js';

export function configuredSmsProvider(): BillingSmsProvider {
  const env = getEnv();
  if (!env.BILLING_SMS_ENABLED || !env.BILLING_SMS_TWILIO_ACCOUNT_SID ||
      !env.BILLING_SMS_TWILIO_API_KEY_SID || !env.BILLING_SMS_TWILIO_API_KEY_SECRET) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_DISABLED');
  }
  return new BillingSmsProvider({ accountSid: env.BILLING_SMS_TWILIO_ACCOUNT_SID,
    apiKeySid: env.BILLING_SMS_TWILIO_API_KEY_SID, apiKeySecret: env.BILLING_SMS_TWILIO_API_KEY_SECRET });
}

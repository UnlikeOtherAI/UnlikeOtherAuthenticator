import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { BillingSmsProvider } from './billing-sms-provider.service.js';

export function configuredSmsProvider(): BillingSmsProvider {
  const env = getEnv();
  if (!env.BILLING_SMS_ENABLED || !env.BILLING_SMS_TWILIO_ACCOUNT_SID ||
      !env.BILLING_SMS_TWILIO_API_KEY_SID || !env.BILLING_SMS_TWILIO_API_KEY_SECRET) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_DISABLED');
  }
  const region = process.env.BILLING_SMS_TWILIO_REGION ?? 'us1';
  if (region !== 'us1' && region !== 'ie1') {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  }
  return new BillingSmsProvider({ accountSid: env.BILLING_SMS_TWILIO_ACCOUNT_SID,
    apiKeySid: env.BILLING_SMS_TWILIO_API_KEY_SID, apiKeySecret: env.BILLING_SMS_TWILIO_API_KEY_SECRET,
    region, ie1ApiKeySid: process.env.BILLING_SMS_TWILIO_IE1_API_KEY_SID,
    ie1ApiKeySecret: process.env.BILLING_SMS_TWILIO_IE1_API_KEY_SECRET });
}

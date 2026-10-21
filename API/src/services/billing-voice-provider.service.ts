import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { SmsProviderConfiguration } from './billing-sms-provider.service.js';

const money = z.string().regex(/^\d+(?:\.\d{1,18})?$/).max(60);
const price = z.object({ current_price: money.nullable() });
export type VoiceRoute = { accountSid: string; from: string; to: string; direction: 'inbound' | 'outbound' };
export type VoiceReceipt = { terminal: boolean; amount: string | null; currency: string | null;
  seconds: number | null; parentCallSid: string | null; startedAt: Date | null };
function unavailable(): AppError { return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_VOICE_EVIDENCE_UNAVAILABLE'); }

/** Read-only Twilio evidence. No customer-supplied URL, price, region or account credential. */
export class BillingVoiceProvider {
  public constructor(public readonly configuration: SmsProviderConfiguration,
    private readonly transport: typeof fetch = fetch) {}
  private async read(path: string, pricing = false): Promise<unknown> {
    const regional = !pricing && this.configuration.region === 'ie1';
    const host = pricing ? 'pricing.twilio.com' : regional ? 'api.dublin.ie1.twilio.com' : 'api.twilio.com';
    const sid = regional ? this.configuration.ie1ApiKeySid : this.configuration.apiKeySid;
    const secret = regional ? this.configuration.ie1ApiKeySecret : this.configuration.apiKeySecret;
    if (!sid || !secret) throw unavailable();
    try {
      const response = await this.transport(`https://${host}${path}`, { redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}`,
        } });
      const text = await response.text();
      if (!response.ok || text.length > 1000000) throw unavailable();
      return JSON.parse(text) as unknown;
    } catch { throw unavailable(); }
  }
  public async ownedNumber(accountSid: string, numberSid: string, phone: string): Promise<void> {
    if (accountSid !== this.configuration.accountSid || !/^PN[\da-f]{32}$/i.test(numberSid)) throw unavailable();
    // Inventory remains in US1, independently of the calls region.
    const inventory = new BillingVoiceProvider({ ...this.configuration, region: 'us1' }, this.transport);
    const raw = await inventory.read(`/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`);
    const parsed = z.object({ sid: z.literal(numberSid), account_sid: z.literal(accountSid),
      phone_number: z.literal(phone), capabilities: z.object({ voice: z.literal(true) }) }).safeParse(raw);
    if (!parsed.success) throw unavailable();
  }
  public async price(route: VoiceRoute): Promise<{ amount: string; currency: 'USD'; source: string }> {
    if (route.accountSid !== this.configuration.accountSid) throw unavailable();
    const number = route.to;
    if (!/^\+[1-9]\d{6,14}$/.test(number)) throw unavailable();
    const source = `/v2/Voice/Numbers/${encodeURIComponent(number)}`;
    const raw = await this.read(source, true);
    const parsed = z.object({ destination_number: z.literal(number), price_unit: z.string(),
      outbound_call_prices: z.array(price).optional(), inbound_call_price: price.nullable().optional() }).safeParse(raw);
    if (!parsed.success || parsed.data.price_unit.toUpperCase() !== 'USD') throw unavailable();
    // Conservative maximum over ALL offered origins; never accept a cheap caller-selected origin.
    const rates = route.direction === 'inbound' ? [parsed.data.inbound_call_price]
      : parsed.data.outbound_call_prices;
    if (!rates?.length || rates.some(rate => !rate || rate.current_price === null)) throw unavailable();
    const amounts = rates.map(rate => {
      if (!rate || rate.current_price === null) throw unavailable();
      return new Prisma.Decimal(rate.current_price);
    });
    return { amount: Prisma.Decimal.max(...amounts).toFixed(), currency: 'USD', source: `https://pricing.twilio.com${source}` };
  }
  public async receipt(route: VoiceRoute, callSid: string): Promise<VoiceReceipt> {
    if (route.accountSid !== this.configuration.accountSid || !/^CA[\da-f]{32}$/i.test(callSid)) throw unavailable();
    const raw = await this.read(`/2010-04-01/Accounts/${route.accountSid}/Calls/${callSid}.json`);
    const parsed = z.object({ sid: z.literal(callSid), account_sid: z.literal(route.accountSid),
      from: z.literal(route.from), to: z.literal(route.to), direction: z.string(), status: z.string(),
      price: z.string().regex(/^-?\d+(?:\.\d{1,18})?$/).nullable(), price_unit: z.string().nullable(),
      duration: z.string().regex(/^\d+$/).nullable(), parent_call_sid: z.string().nullable(),
      start_time: z.string().nullable() }).safeParse(raw);
    if (!parsed.success) throw unavailable();
    const data = parsed.data;
    if ((route.direction === 'inbound' && data.direction !== 'inbound') ||
        (route.direction === 'outbound' && !['outbound-api', 'outbound-dial'].includes(data.direction))) throw unavailable();
    const startedAt = data.start_time ? new Date(data.start_time) : null;
    const seconds = data.duration === null ? null : Number(data.duration);
    if ((startedAt && !Number.isFinite(startedAt.getTime())) ||
        (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 0))) throw unavailable();
    // Twilio reports charges as negative prices. A positive price is not a charge receipt.
    if (data.price !== null && new Prisma.Decimal(data.price).greaterThan(0)) throw unavailable();
    return { terminal: ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(data.status),
      amount: data.price === null ? null : new Prisma.Decimal(data.price).abs().toFixed(),
      currency: data.price_unit?.toUpperCase() ?? null, seconds, parentCallSid: data.parent_call_sid, startedAt };
  }
}

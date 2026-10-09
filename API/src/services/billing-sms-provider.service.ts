import { z } from 'zod';
import { AppError } from '../utils/errors.js';

const money = z.string().regex(/^\d+(?:\.\d+)?$/).max(80);
const currency = z.string().regex(/^[a-zA-Z]{3}$/).transform((value) => value.toUpperCase());
const price = z.object({ number_type: z.string(), current_price: money.nullable() });
const countryPrice = z.object({ country: z.string(), iso_country: z.string(), price_unit: currency });
const messaging = countryPrice.extend({
  inbound_sms_prices: z.array(price),
  outbound_sms_prices: z.array(z.object({
    carrier: z.string(), mcc: z.string(), mnc: z.string(), prices: z.array(price),
  })),
});
const numbers = countryPrice.extend({ phone_number_prices: z.array(price) });

/** Private provider evidence; never serialize this object into customer responses. */
export type SmsPrivatePrice = {
  amount: string;
  currency: string;
  country: string;
  source: string;
  observedAt: Date;
};

export type SmsProviderConfiguration = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
};

function unavailable(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
}

function compareDecimals(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, '0'));
  const bv = BigInt(bi + bf.padEnd(scale, '0'));
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export class BillingSmsProvider {
  public constructor(
    public readonly configuration: SmsProviderConfiguration,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^AC[0-9a-fA-F]{32}$/.test(configuration.accountSid) ||
        !/^SK[0-9a-fA-F]{32}$/.test(configuration.apiKeySid) || !configuration.apiKeySecret) {
      throw unavailable();
    }
  }

  private async read(url: string, allowMissing = false): Promise<unknown> {
    try {
      const response = await this.transport(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Basic ${Buffer.from(
          `${this.configuration.apiKeySid}:${this.configuration.apiKeySecret}`,
        ).toString('base64')}` },
      });
      const body = await response.text();
      if (body.length > 1_000_000) throw unavailable();
      if (allowMissing && response.status === 404) {
        const error = z.object({ code: z.literal(20404) }).safeParse(JSON.parse(body));
        if (error.success) return null;
      }
      if (!response.ok) throw unavailable();
      return JSON.parse(body) as unknown;
    } catch {
      // Provider responses, URLs and credential material never enter customer errors.
      throw unavailable();
    }
  }

  public async assertAvailableMobile(country: string, phone: string): Promise<void> {
    if (!/^[A-Z]{2}$/.test(country) || !/^\+[1-9]\d{6,14}$/.test(phone)) throw unavailable();
    const query = new URLSearchParams({ Contains: phone, SmsEnabled: 'true', PageSize: '100' });
    const result = z.object({ available_phone_numbers: z.array(z.object({
      phone_number: z.string(), iso_country: z.string(), capabilities: z.object({ sms: z.boolean() }),
    })) }).safeParse(await this.read(`https://api.twilio.com/2010-04-01/Accounts/` +
      `${this.configuration.accountSid}/AvailablePhoneNumbers/${country}/Mobile.json?${query}`));
    if (!result.success || !result.data.available_phone_numbers.some((number) =>
      number.phone_number === phone && number.iso_country === country && number.capabilities.sms)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
    }
  }

  public async ownedNumber(accountSid: string, sid: string): Promise<{ phone: string; sms: boolean } | null> {
    if (accountSid !== this.configuration.accountSid || !/^PN[0-9a-fA-F]{32}$/.test(sid)) throw unavailable();
    const raw = await this.read(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/` +
      `IncomingPhoneNumbers/${sid}.json`, true);
    if (raw === null) return null;
    const number = z.object({ sid: z.literal(sid), account_sid: z.literal(accountSid),
      phone_number: z.string().regex(/^\+[1-9]\d{6,14}$/),
      capabilities: z.object({ sms: z.boolean() }),
    }).safeParse(raw);
    if (!number.success) throw unavailable();
    return { phone: number.data.phone_number, sms: number.data.capabilities.sms };
  }

  public async destinationCountry(destination: string): Promise<string> {
    if (!/^\+[1-9]\d{6,14}$/.test(destination)) throw unavailable();
    const parsed = z.object({
      valid: z.literal(true), phone_number: z.string(), country_code: z.string().regex(/^[A-Z]{2}$/),
    }).safeParse(await this.read(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(destination)}`,
    ));
    if (!parsed.success || parsed.data.phone_number !== destination) throw unavailable();
    return parsed.data.country_code;
  }

  public async price(country: string, direction: 'monthly' | 'inbound' | 'outbound'):
    Promise<SmsPrivatePrice> {
    if (!/^[A-Z]{2}$/.test(country)) throw unavailable();
    const source = direction === 'monthly'
      ? `https://pricing.twilio.com/v1/PhoneNumbers/Countries/${country}`
      : `https://pricing.twilio.com/v1/Messaging/Countries/${country}`;
    const raw = await this.read(source);
    let amount: string;
    let unit: string;
    if (direction === 'monthly') {
      const parsed = numbers.safeParse(raw);
      if (!parsed.success || parsed.data.iso_country !== country) throw unavailable();
      const mobile = parsed.data.phone_number_prices.filter((entry) => entry.number_type === 'mobile');
      if (mobile.length !== 1 || mobile[0]?.current_price == null) throw unavailable();
      amount = mobile[0].current_price;
      unit = parsed.data.price_unit;
    } else {
      const parsed = messaging.safeParse(raw);
      if (!parsed.success || parsed.data.iso_country !== country) throw unavailable();
      const entries = direction === 'inbound'
        ? parsed.data.inbound_sms_prices.filter((entry) => entry.number_type === 'mobile')
        : parsed.data.outbound_sms_prices.flatMap((carrier) =>
          carrier.prices.filter((entry) => entry.number_type === 'mobile'));
      if (!entries.length || entries.some((entry) => entry.current_price == null)) throw unavailable();
      // A carrier supplied by a consumer cannot narrow the authorization bound.
      amount = entries.map((entry) => {
        if (entry.current_price === null) throw unavailable();
        return entry.current_price;
      }).reduce((highest, current) =>
        compareDecimals(highest, current) >= 0 ? highest : current);
      unit = parsed.data.price_unit;
    }
    return { amount, currency: unit, country, source, observedAt: this.now() };
  }

  public async receipt(binding: {
    accountSid: string; messageSid: string; from: string; to: string; direction: 'inbound' | 'outbound';
    notBefore?: Date;
  }): Promise<{
    amount: string | null; currency: string | null; segments: number | null; terminal: boolean;
  }> {
    if (binding.accountSid !== this.configuration.accountSid ||
        !/^SM[0-9a-fA-F]{32}$/.test(binding.messageSid)) throw unavailable();
    const parsed = z.object({
      sid: z.string(), account_sid: z.string(), from: z.string(), to: z.string(),
      direction: z.enum(['inbound', 'outbound-api', 'outbound-call', 'outbound-reply']),
      status: z.string(), price: z.string().regex(/^-?\d+(?:\.\d+)?$/).max(80).nullable(),
      price_unit: z.string().regex(/^[a-zA-Z]{3}$/).nullable(),
      num_segments: z.string().regex(/^\d+$/).nullable(),
      date_created: z.string().optional(),
    }).safeParse(await this.read(
      `https://api.twilio.com/2010-04-01/Accounts/${binding.accountSid}/Messages/${binding.messageSid}.json`,
    ));
    if (!parsed.success) throw unavailable();
    const data = parsed.data;
    if (binding.notBefore) {
      const created = data.date_created ? new Date(data.date_created).getTime() : Number.NaN;
      // Provider timestamps are second precision; reject messages from any prior second.
      if (!Number.isFinite(created) || created < Math.floor(binding.notBefore.getTime() / 1000) * 1000 ||
          created > this.now().getTime()) throw unavailable();
    }
    if (data.sid !== binding.messageSid || data.account_sid !== binding.accountSid ||
        data.from !== binding.from || data.to !== binding.to ||
        (binding.direction === 'inbound' ? data.direction !== 'inbound' : data.direction === 'inbound')) {
      throw unavailable();
    }
    // Twilio represents charges as negative prices. A positive value is not a charge receipt.
    if (data.price !== null && !data.price.startsWith('-') && compareDecimals(data.price, '0') !== 0) {
      throw unavailable();
    }
    const segments = data.num_segments === null ? null : Number(data.num_segments);
    if (segments !== null && (!Number.isSafeInteger(segments) || segments < 0)) throw unavailable();
    return {
      amount: data.price === null ? null : data.price.replace(/^-/, ''),
      currency: data.price_unit?.toUpperCase() ?? null,
      segments,
      // Official Message read fixtures include priced `sent` messages on routes without DLR.
      terminal: ['delivered', 'undelivered', 'failed', 'received', 'canceled'].includes(data.status) ||
        (data.status === 'sent' && data.price !== null && data.price_unit !== null),
    };
  }

  public async inboundMessage(accountSid: string, sid: string, to: string): Promise<{
    from: string; createdAt: Date;
    receipt: Awaited<ReturnType<BillingSmsProvider['receipt']>>;
  }> {
    if (accountSid !== this.configuration.accountSid || !/^SM[0-9a-fA-F]{32}$/.test(sid)) throw unavailable();
    const metadata = z.object({ sid: z.literal(sid), account_sid: z.literal(accountSid),
      to: z.literal(to), direction: z.literal('inbound'), from: z.string().min(1).max(80),
      date_created: z.string(),
    }).safeParse(await this.read(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`));
    if (!metadata.success) throw unavailable();
    const createdAt = new Date(metadata.data.date_created);
    if (Number.isNaN(createdAt.getTime()) || createdAt > this.now()) throw unavailable();
    return { from: metadata.data.from, createdAt, receipt: await this.receipt({
      accountSid, messageSid: sid, from: metadata.data.from, to, direction: 'inbound',
    }) };
  }
}

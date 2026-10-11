import { describe, expect, it } from 'vitest';
import { BillingSmsProvider } from '../src/services/billing-sms-provider.service.js';

const accountSid = `AC${'1'.repeat(32)}`;
const configuration = {
  accountSid, apiKeySid: `SK${'2'.repeat(32)}`, apiKeySecret: 'synthetic-us1',
  region: 'ie1' as const, ie1ApiKeySid: `SK${'3'.repeat(32)}`, ie1ApiKeySecret: 'synthetic-ie1',
};
const messageSid = `SM${'4'.repeat(32)}`;
const phoneSid = `PN${'5'.repeat(32)}`;
const phone = '+420777111222';
const peer = '+420777111223';
const created = '2026-10-11T08:00:00Z';
const receipt = { sid: messageSid, account_sid: accountSid, from: peer, to: phone,
  direction: 'inbound', status: 'received', price: '-0.01', price_unit: 'USD',
  num_segments: '1', date_created: created };

function regionalProvider() {
  const calls: { url: string; authorization: string | null }[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(init?.redirect).toBe('error');
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    const body = url.includes('/Messages/') ? receipt
      : url.includes('/AvailablePhoneNumbers/') ? { available_phone_numbers: [
        { phone_number: phone, iso_country: 'CZ', capabilities: { sms: true } }] }
      : url.includes('/IncomingPhoneNumbers/') ? { sid: phoneSid, account_sid: accountSid,
        phone_number: phone, capabilities: { sms: true } }
      : url.includes('lookups.') ? { valid: true, phone_number: peer, country_code: 'CZ' }
      : url.includes('/PhoneNumbers/Countries/')
        ? { country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
          phone_number_prices: [{ number_type: 'mobile', current_price: '1.00' }] }
        : { country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
        inbound_sms_prices: [{ number_type: 'mobile', current_price: '0.01' }],
        outbound_sms_prices: [{ carrier: 'A', mcc: '230', mnc: '01',
          prices: [{ number_type: 'mobile', current_price: '0.02' }] }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, provider: new BillingSmsProvider(configuration, transport,
    () => new Date('2026-10-11T09:00:00Z')) };
}
const basic = (sid: string, secret: string) => `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}`;

describe('SMS evidence region isolation', () => {
  it('reads IE1 receipts, inbound recovery and basic Lookup with only IE1 credentials', async () => {
    const { provider, calls } = regionalProvider();
    expect(await provider.destinationCountry(peer)).toBe('CZ');
    expect(await provider.receipt({ accountSid, messageSid, from: peer, to: phone, direction: 'inbound' }))
      .toMatchObject({ amount: '0.01', terminal: true });
    expect(await provider.inboundMessage(accountSid, messageSid, phone)).toMatchObject({ from: peer });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe(`https://lookups.dublin.ie1.twilio.com/v2/PhoneNumbers/${encodeURIComponent(peer)}`);
    for (const call of calls.slice(1)) {
      expect(call.url).toBe(`https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`);
    }
    expect(calls.every((call) => call.authorization === basic(configuration.ie1ApiKeySid, configuration.ie1ApiKeySecret))).toBe(true);
  });

  it('keeps availability, ownership and all pricing on US1 with only US1 credentials', async () => {
    const { provider, calls } = regionalProvider();
    await provider.assertAvailableMobile('CZ', phone);
    await provider.ownedNumber(accountSid, phoneSid);
    for (const direction of ['monthly', 'inbound', 'outbound'] as const) await provider.price('CZ', direction);
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
      'api.twilio.com', 'api.twilio.com', 'pricing.twilio.com', 'pricing.twilio.com', 'pricing.twilio.com',
    ]);
    expect(calls.every((call) => call.authorization === basic(configuration.apiKeySid, configuration.apiKeySecret))).toBe(true);
  });

  it('fails closed on absent, malformed or reused regional credentials', () => {
    for (const change of [
      { ie1ApiKeySid: undefined }, { ie1ApiKeySecret: undefined }, { ie1ApiKeySecret: '' },
      { ie1ApiKeySid: 'invalid' }, { ie1ApiKeySid: configuration.apiKeySid },
    ]) {
      expect(() => new BillingSmsProvider({ ...configuration, ...change }))
        .toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    }
  });

  it.each([401, 404, 500])('never retries a failed regional read (%s) through US1', async (status) => {
    const calls: string[] = [];
    const provider = new BillingSmsProvider(configuration, (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 20404 }), { status });
    }) as typeof fetch);
    await expect(provider.receipt({ accountSid, messageSid, from: peer, to: phone, direction: 'inbound' }))
      .rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    expect(calls).toEqual([`https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}.json`]);
  });
});

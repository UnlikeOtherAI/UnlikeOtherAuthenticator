import { describe, expect, it } from 'vitest';
import { BillingSmsProvider } from '../src/services/billing-sms-provider.service.js';

const accountSid = `AC${'1'.repeat(32)}`;
function provider(body: unknown, inspect?: (url: string) => void) {
  return new BillingSmsProvider({
    accountSid, apiKeySid: `SK${'2'.repeat(32)}`, apiKeySecret: 'synthetic-test-key',
  }, (async (url: string | URL | Request) => {
    inspect?.(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
}

describe('SMS private provider evidence', () => {
  it('admits only the exact SMS-capable mobile inventory identity', async () => {
    const phone = '+420777111222';
    await provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'CZ',
      capabilities: { sms: true } }] }).assertAvailableMobile('CZ', phone);
    await expect(provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'GB',
      capabilities: { sms: true } }] }).assertAvailableMobile('CZ', phone))
      .rejects.toThrow('BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
    await expect(provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'CZ',
      capabilities: { sms: false } }] }).assertAvailableMobile('CZ', phone))
      .rejects.toThrow('BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
  });
  it('binds owned number evidence to the configured provider account and exact SID', async () => {
    const sid = `PN${'4'.repeat(32)}`;
    expect(await provider({ sid, account_sid: accountSid, phone_number: '+420777111222',
      capabilities: { sms: true } }).ownedNumber(accountSid, sid))
      .toEqual({ phone: '+420777111222', sms: true });
    await expect(provider({}).ownedNumber(`AC${'5'.repeat(32)}`, sid))
      .rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    await expect(provider({ sid: `PN${'6'.repeat(32)}`, account_sid: accountSid,
      phone_number: '+420777111222', capabilities: { sms: true } }).ownedNumber(accountSid, sid))
      .rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });
  it('accepts only documented missing-number evidence, never another account', async () => {
    const sid = `PN${'4'.repeat(32)}`;
    const transport = (async () => new Response(JSON.stringify({ code: 20404 }), { status: 404 })) as typeof fetch;
    const value = new BillingSmsProvider({ accountSid, apiKeySid: `SK${'2'.repeat(32)}`,
      apiKeySecret: 'synthetic-test-key' }, transport);
    expect(await value.ownedNumber(accountSid, sid)).toBeNull();
    await expect(value.ownedNumber(`AC${'5'.repeat(32)}`, sid))
      .rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });
  it.each(['USD', 'usd', 'eur'])('normalizes documented provider price currency %s', async (unit) => {
    const value = await provider({ country: 'Czech Republic', iso_country: 'CZ', price_unit: unit,
      phone_number_prices: [{ number_type: 'mobile', current_price: '1.00' }],
    }).price('CZ', 'monthly');
    expect(value.currency).toBe(unit.toUpperCase());
  });
  it('uses the maximum mobile rate across all carriers without floating point', async () => {
    const value = await provider({ country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
      inbound_sms_prices: [], outbound_sms_prices: [
        { carrier: 'A', mcc: '230', mnc: '01', prices: [
          { number_type: 'mobile', current_price: '0.000000000000000019' },
        ] },
        { carrier: 'B', mcc: '230', mnc: '02', prices: [
          { number_type: 'mobile', current_price: '0.00000000000000002' },
        ] },
      ],
    }).price('CZ', 'outbound');
    expect(value.amount).toBe('0.00000000000000002');
  });

  it('refuses incomplete carrier evidence and country mismatches', async () => {
    await expect(provider({ country: 'United Kingdom', iso_country: 'GB', price_unit: 'USD',
      phone_number_prices: [{ number_type: 'mobile', current_price: '1.00' }],
    }).price('CZ', 'monthly')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    await expect(provider({ country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
      inbound_sms_prices: [], outbound_sms_prices: [
        { carrier: 'A', mcc: '230', mnc: '01', prices: [{ number_type: 'mobile', current_price: null }] },
      ],
    }).price('CZ', 'outbound')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });

  it('uses Basic Lookup without paid fields and checks exact normalized destination', async () => {
    let requested = '';
    const country = await provider({ valid: true, phone_number: '+420777111222', country_code: 'CZ' },
      (url) => { requested = url; }).destinationCountry('+420777111222');
    expect(country).toBe('CZ');
    expect(requested).toBe('https://lookups.twilio.com/v2/PhoneNumbers/%2B420777111222');
    await expect(provider({ valid: true, phone_number: '+420777111223', country_code: 'CZ' })
      .destinationCountry('+420777111222')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });

  it('does not turn an unpriced failed message into a free receipt', async () => {
    const messageSid = `SM${'3'.repeat(32)}`;
    const receipt = await provider({ sid: messageSid, account_sid: accountSid,
      from: '+420777111222', to: '+420777111223', direction: 'outbound-api', status: 'failed',
      price: null, price_unit: null, num_segments: '1',
    }).receipt({ accountSid, messageSid, from: '+420777111222', to: '+420777111223', direction: 'outbound' });
    expect(receipt).toEqual({ amount: null, currency: null, segments: 1, terminal: true });
  });

  it('accepts a priced sent receipt without requiring a delivery callback', async () => {
    const messageSid = `SM${'3'.repeat(32)}`;
    const receipt = await provider({ sid: messageSid, account_sid: accountSid,
      from: '+420777111222', to: '+420777111223', direction: 'outbound-api', status: 'sent',
      price: '-0.00750', price_unit: 'usd', num_segments: '1',
    }).receipt({ accountSid, messageSid, from: '+420777111222', to: '+420777111223', direction: 'outbound' });
    expect(receipt).toEqual({ amount: '0.00750', currency: 'USD', segments: 1, terminal: true });
  });
});

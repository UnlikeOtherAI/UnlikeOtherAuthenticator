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
  it('requires a matching mobile inventory number with an explicit capability', async () => {
    const phone = '+420777111222';
    await provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'CZ',
      capabilities: { sms: true } }] }).assertAvailableNumber('CZ', phone);
    await expect(provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'GB',
      capabilities: { sms: true } }] }).assertAvailableNumber('CZ', phone))
      .rejects.toThrow('BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
    await expect(provider({ available_phone_numbers: [{ phone_number: phone, iso_country: 'CZ',
      capabilities: { sms: false } }] }).assertAvailableNumber('CZ', phone))
      .rejects.toThrow('BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
  });
  it('reads the uppercase capability keys the AvailablePhoneNumbers resource actually returns', async () => {
    const phone = '+447463595266';
    // Shape of a live Twilio AvailablePhoneNumbers/GB/Mobile read: capability keys are upper case.
    const live = (capabilities: Record<string, boolean>) => provider({ available_phone_numbers: [{
      friendly_name: '+44 7463 595266', phone_number: phone, lata: null, locality: null, rate_center: null,
      latitude: null, longitude: null, region: null, postal_code: null, iso_country: 'GB',
      address_requirements: 'none', beta: false, capabilities }], uri: '/2010-04-01/Accounts/x/AvailablePhoneNumbers/GB/Mobile.json' });
    await live({ MMS: false, SMS: true, voice: true }).assertAvailableNumber('GB', phone);
    await live({ MMS: false, SMS: false, voice: true }).assertAvailableNumber('GB', phone);
    for (const capabilities of [{ MMS: true, SMS: false, voice: false }, { MMS: false },
      { SMS: true, sms: false }, { SMS: false, sms: true }]) {
      await expect(live(capabilities).assertAvailableNumber('GB', phone))
        .rejects.toThrow('BILLING_SMS_MOBILE_NUMBER_UNAVAILABLE');
    }
  });
  it('binds a Czech voice-only national offer to its exact country, rental class and E.164', async () => {
    const phone = '+420910123456';
    const reads: string[] = [];
    const api = new BillingSmsProvider({ accountSid, apiKeySid: `SK${'2'.repeat(32)}`, apiKeySecret: 'unused' },
      async (url) => {
        reads.push(String(url));
        return new Response(JSON.stringify(String(url).includes('pricing.twilio.com')
          ? { iso_country: 'CZ', country: 'Czechia', price_unit: 'USD',
            phone_number_prices: [{ number_type: 'national', current_price: '1.50' }] }
          : { available_phone_numbers: [{ phone_number: phone, iso_country: 'CZ', capabilities: { voice: true, SMS: false } }] }));
      });
    await api.assertAvailableNumber('CZ', phone, 'national');
    expect(new URL(reads[1] ?? '').pathname).toMatch(/CZ\/Local\.json$/);
    await expect(api.assertAvailableNumber('CZ', phone, 'local')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });

  it('uses the sending or receiving number class for SMS rates', async () => {
    const prices = [{ number_type: 'mobile', current_price: '0.01' }, { number_type: 'toll free', current_price: '0.04' }];
    const api = provider({ country: 'US', iso_country: 'US', price_unit: 'USD', inbound_sms_prices: prices,
      outbound_sms_prices: [{ carrier: 'Fixture', mcc: '310', mnc: '001', prices }] });
    expect((await api.price('US', 'outbound', 'toll-free')).amount).toBe('0.04');
    expect((await api.price('US', 'inbound', 'toll-free')).amount).toBe('0.04');
    await expect(api.price('US', 'inbound', 'national')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });

  it('binds owned number evidence to the configured provider account and exact SID', async () => {
    const sid = `PN${'4'.repeat(32)}`;
    expect(await provider({ sid, account_sid: accountSid, phone_number: '+420777111222',
      capabilities: { sms: true } }).ownedNumber(accountSid, sid))
      .toEqual({ phone: '+420777111222', sms: true, voice: false });
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
  it('refuses newly exposed number setup or ancillary charges instead of silently dropping them', async () => {
    for (const extra of [{ setup_price: '5.00' }, { recurring_fee: '1.00' }]) {
      await expect(provider({ country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
        phone_number_prices: [{ number_type: 'mobile', current_price: '1.00', ...extra }],
      }).price('CZ', 'monthly')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    }
    await expect(provider({ country: 'Czech Republic', iso_country: 'CZ', price_unit: 'USD',
      setup_fee: '5.00', phone_number_prices: [{ number_type: 'mobile', current_price: '1.00' }],
    }).price('CZ', 'monthly')).rejects.toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
  });

});

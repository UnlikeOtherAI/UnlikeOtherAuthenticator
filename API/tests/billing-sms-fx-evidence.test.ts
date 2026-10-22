import { describe, expect, it } from 'vitest';
import { parseSmsFxEvidence, smsCostReachesPrice, smsFinalUsdQuanta } from '../src/services/billing-sms-fx-evidence.service.js';

const xml = '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  '<Cube><Cube time="2026-10-08"><Cube currency="USD" rate="1.1186"/></Cube></Cube></gesmes:Envelope>';

describe('UOA SMS FX and private rating', () => {
  it('pins source date and rejects stale, duplicate and entity-bearing evidence', () => {
    const evidence = parseSmsFxEvidence(xml, new Date('2026-10-08T18:00:00Z'));
    expect(evidence.expiresAt.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(evidence.usdPerEur).toBe('1.1186');
    expect(() => parseSmsFxEvidence(xml, new Date('2026-10-16T00:00:00Z'))).toThrow();
    expect(() => parseSmsFxEvidence(xml + xml, new Date('2026-10-08T18:00:00Z'))).toThrow();
    expect(() => parseSmsFxEvidence('<!DOCTYPE fake>' + xml, new Date('2026-10-08T18:00:00Z'))).toThrow();
  });

  it('converts a monthly EUR increment exactly and rounds once at Stripe cents', () => {
    expect(smsFinalUsdQuanta({ providerAmount: '2', providerCurrency: 'USD', usdPerEur: '1.1186',
      monthlyFeeEur: '7.25', messageMarkupBps: 2700, direction: 'monthly', quantum: 100n })).toBe(1011n);
    expect(smsFinalUsdQuanta({ providerAmount: '2', providerCurrency: 'EUR', usdPerEur: '1.1186',
      monthlyFeeEur: '7.25', messageMarkupBps: 2700, direction: 'monthly', quantum: 100n })).toBe(1035n);
  });

  it('refuses detached USD, currency namespace overrides, malformed source wrappers and decimal overflow', () => {
    const now = new Date('2026-10-08T18:00:00Z');
    for (const bad of [
      xml.replace('<Cube currency="USD" rate="1.1186"/>', '') + '<Cube currency="USD" rate="1.1186"/>',
      xml.replace('currency="USD"', 'xmlns="https://untrusted.example" currency="USD"'),
      xml.replace('<Cube><Cube', '<wrapper xmlns="https://untrusted.example"><Cube><Cube').replace('</gesmes:Envelope>', '</wrapper></gesmes:Envelope>'),
      xml.replace('gesmes:Envelope', 'fake:Envelope'),
      xml.replace('1.1186', '1.0000000000000000001'),
      xml.replace('1.1186', '0'),
    ]) expect(() => parseSmsFxEvidence(bad, now)).toThrow();
  });

  it('preserves tiny SMS prices and refuses unverified currencies', () => {
    expect(smsFinalUsdQuanta({ providerAmount: '0.00000000001', providerCurrency: 'USD', usdPerEur: '1.1186',
      monthlyFeeEur: '7.25', messageMarkupBps: 2700, direction: 'outbound', quantum: 1_000_000_000n })).toBe(1n);
    expect(() => smsFinalUsdQuanta({ providerAmount: '1', providerCurrency: 'GBP', usdPerEur: '1.1186',
      monthlyFeeEur: '7.25', messageMarkupBps: 2700, direction: 'outbound', quantum: 1_000_000_000n })).toThrow();
  });
  it('marks up all included provider costs exactly once, with no country-specific pricing rule', () => {
    const policy = { monthlyFeeEur: '0', monthlyMarkupBps: 1500, messageMarkupBps: 1500 };
    expect(smsFinalUsdQuanta({ ...policy, providerAmount: '2', providerCurrency: 'USD', usdPerEur: '1.1186',
      direction: 'monthly', quantum: 100n })).toBe(230n);
    expect(smsFinalUsdQuanta({ ...policy, providerAmount: '2', providerCurrency: 'EUR', usdPerEur: '1.1186',
      direction: 'monthly', quantum: 100n })).toBe(258n);
    // A complete charge including transport, carrier and processing fees gets one markup.
    expect(smsFinalUsdQuanta({ ...policy, providerAmount: '0.013', providerCurrency: 'USD', usdPerEur: '1.1186',
      direction: 'outbound', quantum: 1_000_000_000n })).toBe(14_950_000n);
    expect(smsFinalUsdQuanta({ ...policy, providerAmount: '0.001', providerCurrency: 'USD', usdPerEur: '1.1186',
      direction: 'inbound', quantum: 1_000_000_000n })).toBe(1_150_000n);
  });


  it('reads GBP from the same dated cube and refuses a detached or duplicated one', () => {
    const now = new Date('2026-10-08T18:00:00Z');
    const withGbp = xml.replace('<Cube currency="USD" rate="1.1186"/>',
      '<Cube currency="USD" rate="1.1186"/><Cube currency="GBP" rate="0.8437"/>');
    expect(parseSmsFxEvidence(withGbp, now)).toMatchObject({ usdPerEur: '1.1186', gbpPerEur: '0.8437' });
    expect(parseSmsFxEvidence(xml, now).gbpPerEur).toBeNull();
    expect(() => parseSmsFxEvidence(withGbp.replace('<Cube currency="GBP" rate="0.8437"/>',
      '<Cube currency="GBP" rate="0.8437"/><Cube currency="GBP" rate="0.9"/>'), now)).toThrow();
  });

  it('compares a provider cost with a price across USD, EUR and GBP exactly', () => {
    const rates = { usdPerEur: '1.1', gbpPerEur: '0.85' };
    // USD 5.489 is EUR 4.99 exactly: reaching the price counts as below cost.
    expect(smsCostReachesPrice({ costAmount: '5.489', costCurrency: 'USD', priceAmount: '4.99', priceCurrency: 'EUR', rates })).toBe(true);
    expect(smsCostReachesPrice({ costAmount: '5.4889', costCurrency: 'USD', priceAmount: '4.99', priceCurrency: 'EUR', rates })).toBe(false);
    expect(smsCostReachesPrice({ costAmount: '5.00', costCurrency: 'USD', priceAmount: '4.49', priceCurrency: 'GBP', rates })).toBe(false);
    expect(smsCostReachesPrice({ costAmount: '6.00', costCurrency: 'USD', priceAmount: '4.49', priceCurrency: 'GBP', rates })).toBe(true);
    expect(smsCostReachesPrice({ costAmount: '5.49', costCurrency: 'USD', priceAmount: '5.49', priceCurrency: 'USD', rates })).toBe(true);
    expect(() => smsCostReachesPrice({ costAmount: '1', costCurrency: 'USD', priceAmount: '4.49', priceCurrency: 'GBP',
      rates: { usdPerEur: '1.1', gbpPerEur: null } })).toThrow();
  });
});

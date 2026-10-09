import { describe, expect, it } from 'vitest';
import { parseSmsFxEvidence, smsFinalUsdQuanta } from '../src/services/billing-sms-fx-evidence.service.js';

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
});

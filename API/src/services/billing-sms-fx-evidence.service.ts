import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export const SMS_FX_SOURCE = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const SMS_FX_POLICY = 'ECB_REFERENCE_USD_PER_EUR_V1';

export type SmsFxEvidence = {
  policy: typeof SMS_FX_POLICY;
  source: typeof SMS_FX_SOURCE;
  sourceDigest: string;
  rateDate: Date;
  observedAt: Date;
  expiresAt: Date;
  usdPerEur: string;
};

function unavailable(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_FX_EVIDENCE_UNAVAILABLE');
}

/** Validate the bounded, fixed-source ECB reference document before operator acceptance. */
export function parseSmsFxEvidence(xml: string, now: Date): SmsFxEvidence {
  if (xml.length > 100_000 || /<!DOCTYPE|<!ENTITY|<!--[\s\S]*?-->/i.test(xml)) throw unavailable();
  const envelope = xml.match(/^\s*(?:<\?xml[^?]*\?>\s*)?<gesmes:Envelope\s+([^>]+)>([\s\S]*)<\/gesmes:Envelope>\s*$/);
  const envelopeAttributes = envelope?.[1];
  if (!envelopeAttributes || !/(?:^|\s)xmlns=['"]http:\/\/www\.ecb\.int\/vocabulary\/2002-08-01\/eurofxref['"](?:\s|$)/.test(envelopeAttributes)) throw unavailable();
  // A wrapper must not silently move unprefixed Cube descendants out of ECB's
  // namespace while retaining the expected default declaration at the root.
  if (/\sxmlns\s*=/.test(envelope?.[2] ?? '')) throw unavailable();
  // Rates must be direct children of the one dated ECB Cube, not a detached USD
  // tag that happens to accompany a valid date elsewhere in an imported document.
  const block = xml.match(/<Cube>\s*<Cube\s+time=['"]\d{4}-\d{2}-\d{2}['"]\s*>([\s\S]*?)<\/Cube>\s*<\/Cube>/);
  const rates = block?.[1];
  if (!rates || rates.replace(/<Cube\s+currency=['"][A-Z]{3}['"]\s+rate=['"]\d+(?:\.\d+)?['"]\s*\/>/g, '').trim()) throw unavailable();
  const dates = [...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g)];
  const usd = [...xml.matchAll(/<Cube\s+currency=['"]USD['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g)];
  if (!rates.includes(usd[0]?.[0] ?? '__missing_usd__')) throw unavailable();
  if (dates.length !== 1 || usd.length !== 1 || !xml.includes('http://www.ecb.int/vocabulary/2002-08-01/eurofxref')) {
    throw unavailable();
  }
  const date = dates[0]?.[1];
  const rate = usd[0]?.[1];
  if (!date || !rate) throw unavailable();
  const rateDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(rateDate.getTime()) || rateDate.toISOString().slice(0, 10) !== date ||
      rateDate.getTime() > now.getTime() || now.getTime() - rateDate.getTime() > 7 * 86_400_000 ||
      !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(rate) || /^0(?:\.0+)?$/.test(rate)) throw unavailable();
  return {
    policy: SMS_FX_POLICY, source: SMS_FX_SOURCE,
    sourceDigest: createHash('sha256').update(xml).digest('hex'), rateDate, observedAt: now,
    // Expiry is based on the source date, so repeated fetching cannot extend stale evidence.
    expiresAt: new Date(rateDate.getTime() + 7 * 86_400_000), usdPerEur: rate,
  };
}

export async function readSmsFxEvidence(
  transport: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<SmsFxEvidence> {
  try {
    const response = await transport(SMS_FX_SOURCE, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw unavailable();
    return parseSmsFxEvidence(await response.text(), now());
  } catch {
    throw unavailable();
  }
}

function fraction(decimal: string): { numerator: bigint; denominator: bigint } {
  if (!/^\d+(?:\.\d+)?$/.test(decimal) || decimal.length > 80) throw unavailable();
  const [integer, digits = ''] = decimal.split('.');
  return { numerator: BigInt(integer + digits), denominator: 10n ** BigInt(digits.length) };
}

/** Exact USD rational arithmetic, rounding once upwards at the specified billing quantum. */
export function smsFinalUsdQuanta(input: {
  providerAmount: string; providerCurrency: string; usdPerEur: string;
  direction: 'monthly' | 'inbound' | 'outbound'; quantum: bigint;
  monthlyFeeEur: string; messageMarkupBps: number;
}): bigint {
  const provider = fraction(input.providerAmount);
  const fx = fraction(input.usdPerEur);
  let numerator = provider.numerator;
  let denominator = provider.denominator;
  if (input.providerCurrency === 'EUR') {
    numerator *= fx.numerator;
    denominator *= fx.denominator;
  } else if (input.providerCurrency !== 'USD') {
    throw unavailable();
  }
  if (input.direction === 'monthly') {
    const fee = fraction(input.monthlyFeeEur);
    numerator = numerator * fx.denominator * fee.denominator + fee.numerator * fx.numerator * denominator;
    denominator *= fx.denominator * fee.denominator;
  } else {
    if (!Number.isSafeInteger(input.messageMarkupBps) || input.messageMarkupBps < 0) throw unavailable();
    numerator *= 10_000n + BigInt(input.messageMarkupBps);
    denominator *= 10_000n;
  }
  if (input.quantum <= 0n) throw unavailable();
  return (numerator * input.quantum + denominator - 1n) / denominator;
}

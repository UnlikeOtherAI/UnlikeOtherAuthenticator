import { readSmsCommercialPolicy } from './billing-sms-commercial-policy.service.js';
import { Prisma, type BillingSmsQuote, type PrismaClient } from '@prisma/client';
import type {
  BillingSmsFinalQuoteV1, BillingSmsQuoteRequestV1, BillingSmsVerifyQuoteRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { lockSmsSubject, verifySmsActor } from './billing-sms-authority.service.js';
import { smsFinalUsdQuanta } from './billing-sms-fx-evidence.service.js';
import type { BillingSmsProvider } from './billing-sms-provider.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { sumSmsAmounts } from './billing-sms-money.service.js';

const QUOTE_TTL_MS = 5 * 60_000;
// A microcredit is USD 0.000000001. A displayed maximum must cover the wallet ceiling.
const PRICE_QUANTUM = 10n ** 9n;

function unavailable(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_QUOTE_UNAVAILABLE');
}

function exactDecimal(value: string): Prisma.Decimal {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw unavailable();
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative() || decimal.greaterThanOrEqualTo('1e20')) throw unavailable();
  return decimal;
}

function formattedQuanta(value: bigint, places: number): string {
  const digits = value.toString().padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export function publicSmsQuote(quote: BillingSmsQuote): BillingSmsFinalQuoteV1 {
  if (!['monthly_mobile', 'inbound_mobile', 'maximum_mobile_carrier'].includes(quote.rateBasis) ||
      !['monthly', 'inbound', 'outbound'].includes(quote.direction) || quote.finalCurrency !== 'USD') {
    throw unavailable();
  }
  return {
    id: quote.id, amount: quote.finalAmount.toFixed(quote.direction === 'monthly' ? 2 : 18),
    currency: 'USD', expires_at: quote.expiresAt.toISOString(),
    rate_basis: quote.rateBasis as BillingSmsFinalQuoteV1['rate_basis'],
    scope: { organisation_id: quote.orgId, country: quote.country, number_type: 'mobile',
      direction: quote.direction as BillingSmsFinalQuoteV1['scope']['direction'],
      destination: quote.destination, carrier: null, mcc: null, mnc: null },
  };
}

function assertQuoteScope(quote: BillingSmsQuote, request: BillingSmsQuoteRequestV1,
  credential: VerifiedBillingAppKey): void {
  if (quote.serviceId !== credential.service.id || quote.orgId !== request.organisation_id ||
      quote.country !== request.country || quote.direction !== request.direction ||
      quote.destination !== request.destination || request.number_type !== 'mobile' ||
      request.carrier !== null || request.mcc !== null || request.mnc !== null) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_QUOTE_SCOPE_MISMATCH');
  }
}

export async function createSmsQuote(input: {
  request: BillingSmsQuoteRequestV1; actorToken: string; credential: VerifiedBillingAppKey;
}, deps: { provider: BillingSmsProvider; prisma?: PrismaClient; now?: () => Date }): Promise<BillingSmsFinalQuoteV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const actor = await verifySmsActor({ subject: input.request, actorToken: input.actorToken,
    credential: input.credential, endpoint: '/billing/v1/sms/quotes' });
  return issueSmsQuote({ request: input.request, credential: input.credential,
    authorize: (tx) => lockSmsSubject(tx, { subject: input.request, actor, credential: input.credential }) },
  { ...deps, prisma });
}

/** Internal seam: only verified human or durable delegated authority supplies the transaction admission. */
export async function issueSmsQuote(input: { request: BillingSmsQuoteRequestV1; credential: VerifiedBillingAppKey;
  authorize: (tx: Prisma.TransactionClient) => Promise<unknown> },
deps: { provider: BillingSmsProvider; prisma?: PrismaClient; now?: () => Date }): Promise<BillingSmsFinalQuoteV1> {
  const prisma = deps.prisma ?? getAdminPrisma();
  const request = input.request;
  const commercial = readSmsCommercialPolicy();
  if (request.carrier !== null || request.mcc !== null || request.mnc !== null ||
      request.number_type !== 'mobile' || !/^[A-Z]{2}$/.test(request.country) ||
      (request.direction === 'outbound' ? !request.destination : request.destination !== null)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_SMS_QUOTE_SCOPE_INVALID');
  }
  if (request.direction === 'outbound' && request.destination !== null &&
      await deps.provider.destinationCountry(request.destination) !== request.country) {
    throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_DESTINATION_COUNTRY_MISMATCH');
  }
  const price = await deps.provider.price(request.country, request.direction);
  const providerAmount = exactDecimal(price.amount);
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await input.authorize(tx);
    const now = deps.now?.() ?? new Date();
    const fx = await tx.billingSmsFxSnapshot.findFirst({
      where: { expiresAt: { gt: now }, policy: 'ECB_REFERENCE_USD_PER_EUR_V1' },
      orderBy: [{ rateDate: 'desc' }, { acceptedAt: 'desc' }],
    });
    if (!fx) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_FX_POLICY_REQUIRED');
    const monthly = request.direction === 'monthly';
    const policy = monthly ? null : await tx.billingSmsRoutePolicy.findFirst({ where: {
      accountSid: deps.provider.configuration.accountSid, country: request.country,
      direction: request.direction, currency: price.currency, expiresAt: { gt: now },
    }, orderBy: { acceptedAt: 'desc' } });
    if (!monthly && !policy) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SMS_ROUTE_BOUND_REQUIRED');
    // Per-message fees are conservatively included in every segment of the displayed maximum.
    // Settlement uses only the independently verified actual provider charge.
    const providerBound = policy ? sumSmsAmounts([providerAmount.toFixed(),
      policy.additionalPerSegment.toFixed(), policy.additionalPerMessage.toFixed()])
      : providerAmount;
    const finalQuanta = smsFinalUsdQuanta({ providerAmount: providerBound.toFixed(),
      providerCurrency: price.currency, usdPerEur: fx.usdPerEur.toFixed(),
      ...commercial, direction: request.direction, quantum: monthly ? 100n : PRICE_QUANTUM });
    const quote = await tx.billingSmsQuote.create({ data: {
      serviceId: input.credential.service.id, appKeyId: input.credential.id, orgId: request.organisation_id,
      country: request.country, direction: request.direction, destination: request.destination,
      commercialPolicyVersion: commercial.version, monthlyFeeEur: commercial.monthlyFeeEur,
      messageMarkupBps: commercial.messageMarkupBps, providerAmount, providerCurrency: price.currency, providerSource: price.source,
      providerObservedAt: price.observedAt, fxSnapshotId: fx.id,
      providerBoundAmount: providerBound, routePolicyId: policy?.id ?? null,
      finalAmount: formattedQuanta(finalQuanta, monthly ? 2 : 9), finalCurrency: 'USD',
      rateBasis: monthly ? 'monthly_mobile' : request.direction === 'inbound'
        ? 'inbound_mobile' : 'maximum_mobile_carrier',
      expiresAt: new Date(Math.min(now.getTime() + QUOTE_TTL_MS, fx.expiresAt.getTime(),
        policy?.expiresAt.getTime() ?? Number.POSITIVE_INFINITY)),
    } });
    return publicSmsQuote(quote);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

export async function verifySmsQuote(input: {
  request: BillingSmsVerifyQuoteRequestV1; actorToken: string; credential: VerifiedBillingAppKey;
}, deps?: { prisma?: PrismaClient; now?: () => Date }): Promise<BillingSmsFinalQuoteV1> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const actor = await verifySmsActor({ subject: input.request, actorToken: input.actorToken,
    credential: input.credential, endpoint: '/billing/v1/sms/quotes/verify' });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockSmsSubject(tx, { subject: input.request, actor, credential: input.credential });
    const quote = await tx.billingSmsQuote.findUnique({ where: { id: input.request.quote_id } });
    if (!quote) throw new AppError('NOT_FOUND', 404, 'BILLING_SMS_QUOTE_NOT_FOUND');
    assertQuoteScope(quote, input.request, input.credential);
    if (quote.expiresAt.getTime() <= (deps?.now?.() ?? new Date()).getTime()) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_SMS_QUOTE_EXPIRED');
    }
    return publicSmsQuote(quote);
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

import { fundingScopeEpoch } from './billing-credit-funding-actions.persistence.fixture.js';
import { BillingCreditCheckoutStatus } from '@prisma/client';
import { expect, it, vi } from 'vitest';

import { applyCreditFundingWebhook } from '../../src/services/billing-credit-funding-webhook.service.js';
import { reconcileCreditCheckout } from '../../src/services/billing-credit-checkout-recovery.service.js';

import { fundingRaceIds as ids, stripeAccount } from './billing-credit-funding-actions.persistence.fixture.js';
import { handle } from './billing-credit-funding-actions.suite-fixture.js';

export function registerCases1() {
  it('commits the credit, accepted payment, and invoice source together after webhook replay', async () => {
    const checkoutId = 'bcsc_funding_race_payment_invoice';
    const checkoutSessionId = 'cs_funding_race_payment_invoice';
    const paymentIntentId = 'pi_funding_race_payment_invoice';
    const chargeId = 'ch_funding_race_payment_invoice';
    const webhookEventId = 'bswe_funding_race_payment_invoice';
    const acceptedAt = new Date('2026-08-31T23:59:58.000Z');
    await handle!.prisma.billingCreditTopUpCheckout.create({
      data: {
        billingModeTeamId: ids.team, billingModeRevision: 1,billingScopeEpoch:fundingScopeEpoch,
        id: checkoutId, accountId: ids.account,
        creditAccountId: ids.creditAccount, customerId: ids.customer,
        catalogId: ids.catalog, serviceId: ids.service, appKeyId: ids.appKey,
        offerId: ids.offer, actorJti: checkoutId, requestedByUserId: ids.user,
        paymentAmountMinor: 500n, creditsReceivedMicrocredits: 5_000_000_000n,
        currency: 'USD', successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64),
        leaseExpiresAt: new Date('2026-09-01T01:00:00.000Z'),
      },
    });
    await handle!.prisma.billingCreditTopUpCheckout.update({
      where: { id: checkoutId },
      data: {
        stripeCheckoutSessionId: checkoutSessionId,
        status: BillingCreditCheckoutStatus.OPEN,
      },
    });
    await handle!.prisma.billingStripeWebhookEvent.create({
      data: {
        id: webhookEventId, accountId: ids.account,
        stripeEventId: 'evt_funding_race_payment_invoice',
        type: 'payment_intent.succeeded', livemode: false,
        stripeCreatedAt: acceptedAt, stripeObjectId: paymentIntentId,
        stripeCustomerId: 'cus_funding_race',
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId,
        amountMinor: 500n, currency: 'USD',
      },
    });
    const prepared = {
      event: {
        kind: 'payment_succeeded' as const, localType: 'top_up' as const,
        localId: checkoutId, checkoutSessionId, chargeId,
        paymentMethodId: 'pm_funding_race', occurredAt: acceptedAt,
        paymentIntent: {
          id: paymentIntentId, status: 'succeeded', livemode: false,
          amount_received: 500, currency: 'usd', customer: 'cus_funding_race',
          latest_charge: chargeId,
        } as never,
      },
      eventFields: { stripeCreatedAt: acceptedAt },
    };
    await expect(handle!.prisma.$transaction(async (tx) => {
      await applyCreditFundingWebhook(tx, prepared, webhookEventId, stripeAccount);
      throw new Error('simulated crash before commit');
    })).rejects.toThrow('simulated crash before commit');
    expect(await handle!.prisma.billingCreditPaymentInvoice.count({
      where: { stripePaymentIntentId: paymentIntentId },
    })).toBe(0);
    expect(await handle!.prisma.billingCreditEntry.count({
      where: { idempotencyKey: `stripe:payment-intent:${paymentIntentId}` },
    })).toBe(0);
    await handle!.prisma.$transaction((tx) =>
      applyCreditFundingWebhook(tx, prepared, webhookEventId, stripeAccount));
    await handle!.prisma.$transaction((tx) =>
      applyCreditFundingWebhook(tx, prepared, webhookEventId, stripeAccount));
    const [checkout, entries, invoices] = await Promise.all([
      handle!.prisma.billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id: checkoutId } }),
      handle!.prisma.billingCreditEntry.findMany({
        where: { idempotencyKey: `stripe:payment-intent:${paymentIntentId}` },
      }),
      handle!.prisma.billingCreditPaymentInvoice.findMany({
        where: { stripePaymentIntentId: paymentIntentId },
      }),
    ]);
    expect(checkout.status).toBe(BillingCreditCheckoutStatus.COMPLETE);
    expect(entries).toHaveLength(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      creditEntryId: entries[0]?.id,
      grossAmountMinor: 500n,
      creditsPurchasedMicrocredits: 5_000_000_000n,
      paidAt: acceptedAt,
    });
  }, 30_000);

  it('installs exact app-key/actor/selection replay indexes', async () => {
    const indexes = await handle!.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'billing_credit_top_up_checkouts_actor_offer_key',
          'billing_credit_setup_checkouts_actor_option_key'
        )
      ORDER BY indexname
    `;

    expect(indexes.map((row) => row.indexname)).toEqual([
      'billing_credit_setup_checkouts_actor_option_key',
      'billing_credit_top_up_checkouts_actor_offer_key',
    ]);
  });

  it('does not restore a stale Checkout redirect after a verified payment webhook wins the race', async () => {
    const checkoutId = 'bctc_funding_race_resume';
    await handle!.prisma.billingCreditTopUpCheckout.create({
      data: {
        billingModeTeamId: ids.team, billingModeRevision: 1,billingScopeEpoch:fundingScopeEpoch,
        id: checkoutId,
        accountId: ids.account,
        creditAccountId: ids.creditAccount,
        customerId: ids.customer,
        catalogId: ids.catalog,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        offerId: ids.offer,
        actorJti: 'actor-original-top-up',
        requestedByUserId: ids.user,
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
        currency: 'USD',
        successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64),
        status: BillingCreditCheckoutStatus.CREATING,
        leaseExpiresAt: new Date('2026-07-21T12:10:00.000Z'),
      },
    });
    const openCheckout = await handle!.prisma.billingCreditTopUpCheckout.update({
      where: { id: checkoutId },
      data: {
        stripeCheckoutSessionId: 'cs_funding_race_resume',
        status: BillingCreditCheckoutStatus.OPEN,
        expiresAt: new Date('2026-07-21T12:30:00.000Z'),
      },
    });
    const eventAt = new Date('2026-07-21T12:02:00.000Z');
    const stripeIntent = {
      id: 'pi_funding_race_resume',
      status: 'succeeded',
      amount: 500,
      amount_received: 500,
      currency: 'usd',
      customer: 'cus_funding_race',
      latest_charge: 'ch_funding_race_resume',
      payment_method: 'pm_funding_race',
      livemode: false,
      metadata: {
        uoa_service_id: ids.service,
        uoa_app_key_id: ids.appKey,
        uoa_credit_account_id: ids.creditAccount,
        uoa_credit_top_up_checkout_id: checkoutId,
      },
    };

    const stripe = {
      checkout: {
        sessions: {
          retrieve: vi.fn(async () => {
            await handle!.prisma.$transaction(async (tx) => {
              const webhook = await tx.billingStripeWebhookEvent.create({
                data: {
                  accountId: ids.account,
                  stripeEventId: 'evt_funding_race_resume',
                  type: 'payment_intent.succeeded',
                  apiVersion: '2026-06-24.dahlia',
                  livemode: false,
                  stripeCreatedAt: eventAt,
                  stripeObjectId: stripeIntent.id,
                  stripeCustomerId: 'cus_funding_race',
                  stripeCheckoutSessionId: 'cs_funding_race_resume',
                  stripePaymentIntentId: stripeIntent.id,
                  stripeChargeId: 'ch_funding_race_resume',
                  amountMinor: 500n,
                  currency: 'USD',
                },
              });
              await applyCreditFundingWebhook(
                tx,
                {
                  event: {
                    kind: 'payment_succeeded',
                    localType: 'top_up',
                    localId: checkoutId,
                    paymentIntent: stripeIntent as never,
                    paymentMethodId: 'pm_funding_race',
                    chargeId: 'ch_funding_race_resume',
                    checkoutSessionId: 'cs_funding_race_resume',
                    occurredAt: eventAt,
                  },
                  eventFields: {
                    stripeCreatedAt: eventAt,
                    stripeObjectId: stripeIntent.id,
                    stripeCustomerId: 'cus_funding_race',
                    stripePaymentIntentId: stripeIntent.id,
                    stripeChargeId: 'ch_funding_race_resume',
                    stripeCheckoutSessionId: 'cs_funding_race_resume',
                    stripePaymentMethodId: 'pm_funding_race',
                    amountMinor: 500n,
                    currency: 'USD',
                  },
                },
                webhook.id,
                stripeAccount,
              );
            });
            return {
              id: 'cs_funding_race_resume',
              livemode: false,
              client_reference_id: checkoutId,
              customer: 'cus_funding_race',
              mode: 'payment',
              status: 'open',
              url: 'https://checkout.stripe.com/c/pay/funding-race',
              expires_at: Math.floor(Date.now() / 1000) + 600,
              metadata: {
                uoa_service_id: ids.service,
                uoa_app_key_id: ids.appKey,
                uoa_credit_account_id: ids.creditAccount,
                uoa_credit_top_up_checkout_id: checkoutId,
              },
            } as never;
          }),
          list: vi.fn(),
        },
      },
    };

    await expect(
      reconcileCreditCheckout(
        {
          checkout: openCheckout,
          kind: 'top_up',
          customerStripeId: 'cus_funding_race',
          account: stripeAccount,
          now: eventAt,
        },
        { prisma: handle!.prisma, stripe: stripe as never },
      ),
    ).rejects.toThrow('BILLING_CREDIT_TOP_UP_PREDECESSOR_CHANGED');

    const [savedCheckout, entries] = await Promise.all([
      handle!.prisma.billingCreditTopUpCheckout.findUniqueOrThrow({ where: { id: checkoutId } }),
      handle!.prisma.billingCreditEntry.findMany({
        where: { sourceType: 'credit_top_up_checkout', sourceId: checkoutId },
      }),
    ]);
    expect(savedCheckout.status).toBe(BillingCreditCheckoutStatus.COMPLETE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amountMicrocredits: 5_000_000_000n });
  }, 20_000);
}

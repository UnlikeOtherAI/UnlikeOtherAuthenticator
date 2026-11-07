import { BillingCreditAutoTopUpConsentSource, BillingCreditAutoTopUpState, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { disableBillingCreditAutoTopUp, updateBillingCreditAutoTopUp } from '../../src/services/billing-credit-auto-top-up-consent.service.js';
import { now, credential, request, offer, option, baseContext, selections } from './billing-credit-funding.fixture.js';

describe('UOA automatic credit consent changes', () => {
  it('does not append action evidence when automatic top-up is already disabled', async () => {
    const state = baseContext();

    await disableBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      {
        prisma: {} as PrismaClient,
        resolveContext: vi.fn().mockResolvedValue(state.context),
      },
    );

    expect(state.context.authorizeAction).not.toHaveBeenCalled();
  });

  it('updates immutable consent from the verified customer card and exact option', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpOptionId: option.id,
      autoTopUpConsentRevisionId: 'consent_old',
      stripePaymentMethodId: 'pm_1',
    });
    state.stripe.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_1',
      livemode: false,
      type: 'card',
      customer: 'cus_team_1',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });
    const revisionCreate = vi.fn().mockResolvedValue({ id: 'consent_new' });
    const accountUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_old',
          autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAutoTopUpConsentRevision: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: revisionCreate,
      },
      billingCreditAccount: { updateMany: accountUpdate },
      billingCreditSetupCheckout: { updateMany: vi.fn() },
      orgAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
      billingCreditAutoTopUpConsentRevision: { findUnique: vi.fn() },
    } as unknown as PrismaClient;

    await updateBillingCreditAutoTopUp(
      { request: { ...request, optionId: option.id }, actorToken: 'actor', credential },
      {
        prisma,
        now: () => now,
        resolveContext: vi.fn().mockResolvedValue(state.context),
        resolveOption: vi.fn().mockResolvedValue(selections().option),
        readRegion: vi.fn().mockResolvedValue(null),
        validateCatalog: vi.fn(),
      },
    );

    expect(revisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
        optionId: option.id,
        refillPaymentAmountMinor: offer.paymentAmountMinor,
        stripePaymentMethodId: 'pm_1',
        paymentMethodSummary: expect.objectContaining({ last4: '4242' }),
      }),
    });
    expect(accountUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'credit_account_1', autoTopUpGeneration: 0 }),
      data: expect.objectContaining({
        autoTopUpGeneration: { increment: 1 },
        autoTopUpConsentRevisionId: 'consent_new',
        autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      }),
    });
  });

  it('disables future consent while leaving an older unresolved attempt independent', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpConsentRevisionId: 'consent_1',
      autoTopUpOptionId: option.id,
      stripePaymentMethodId: 'pm_1',
    });
    const accountUpdate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_1',
          autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAccount: {
        update: accountUpdate,
      },
      billingCreditAutoTopUpDisableEvent: { create: vi.fn() },
      billingCreditSetupCheckout: { updateMany: vi.fn() },
      orgAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await disableBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
    );

    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: 'credit_account_1' },
      data: expect.objectContaining({
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpConsentRevisionId: null,
        stripePaymentMethodId: null,
      }),
    });
    expect(tx.billingCreditAutoTopUpDisableEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousConsentRevisionId: 'consent_1',
        previousGeneration: 0,
      }),
    });
  });

  it('keeps disable safe when an unknown pending attempt has no persisted Stripe id', async () => {
    const state = baseContext({
      autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
      autoTopUpConsentRevisionId: 'consent_1',
      autoTopUpOptionId: option.id,
      stripePaymentMethodId: 'pm_1',
    });
    const disableCreate = vi.fn();
    const accountUpdate = vi.fn();
    const attemptRead = vi.fn().mockResolvedValue({
      id: 'attempt_pending',
      status: 'PENDING',
      stripePaymentIntentId: null,
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'credit_account_1',
          autoTopUpGeneration: 0,
          autoTopUpConsentRevisionId: 'consent_1',
          autoTopUpState: BillingCreditAutoTopUpState.NEEDS_REVIEW,
          stripePaymentMethodId: 'pm_1',
        },
      ]),
      billingCreditAutoTopUpDisableEvent: { create: disableCreate },
      billingCreditAutoTopUpAttempt: { findFirst: attemptRead },
      billingCreditSetupCheckout: { updateMany: vi.fn() },
      billingCreditAccount: { update: accountUpdate },
      orgAuditLog: { create: vi.fn() },
    };
    const prisma = {
      billingCreditAutoTopUpAttempt: { findFirst: attemptRead },
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaClient;

    await disableBillingCreditAutoTopUp(
      { request, actorToken: 'actor', credential },
      { prisma, resolveContext: vi.fn().mockResolvedValue(state.context) },
    );

    expect(disableCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ previousConsentRevisionId: 'consent_1' }),
    });
    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: 'credit_account_1' },
      data: expect.objectContaining({
        autoTopUpState: BillingCreditAutoTopUpState.DISABLED,
        autoTopUpConsentRevisionId: null,
      }),
    });
    expect(attemptRead).not.toHaveBeenCalled();
  });
});


import { describe, expect, it } from 'vitest';

import { assertBillingCreditsContract } from '../../src/routes/billing/credits.js';


import { buildBillingCreditsProjection } from '../../src/services/billing-credit-projection.service.js';



import { now, service, credential, collection, period, projectionData, viewer, productionFreshAccountData } from '../helpers/credit-projection-fixture.js';

describe('privacy-safe shared credit projection',()=>{
  it('localizes source-owned credit balance and ledger copy as one language', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: projectionData(),
      now,
      locale: 'cs',
    });

    expect(result.conversion.description).toContain('1 000 kredit');
    expect(result.credit_balance.label).toBe('Zbývající kredity');
    expect(result.credit_balance.display).toContain('kreditů');
    expect(result.viewer.description).toContain('tým');
    expect(result.automatic_top_up.display_status).toBe('Zapnuto');
    expect(result.automatic_top_up.payment_method.display).toBe('Visa končící na 4242');
    expect(result.automatic_top_up.consent.description).toContain('Souhlas platí');
    expect(result.recent_entries[0]?.label).toBe('Kredity přidané službou DeepWater');
    expect(result.recent_entries[0]?.credits.display).toContain('kreditů');
  });


  it('localizes built-in credit offers and automatic top-up choices', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: productionFreshAccountData(),
      now,
      locale: 'cs',
    });

    if (result.viewer.role !== 'billing_manager' || !result.funding_policy) {
      throw new Error('Expected manager funding actions');
    }
    expect(result.funding_policy.title).toBe('Doplnit kredity organizace');
    expect(result.funding_policy.offers[0]).toMatchObject({
      name: 'Malé dobití kreditů',
      description: 'Jednorázové dobití. Nezapíná automatické dobíjení.',
    });
    expect(result.funding_policy.offers[0]?.action?.label).toMatch(/^Koupit /);
    expect(result.automatic_top_up.options[0]?.label).toContain('Dobít');
    expect(result.automatic_top_up.options[0]?.setup_action?.label).toBe(
      'Nastavit automatické dobíjení',
    );
  });


  it('keeps source-authored credit actions in each supported billing locale', () => {
    const cases = [
      ['cs', 'Doplnit kredity organizace', 'Vypnuto', 'Malé dobití kreditů', 'kreditů'],
      ['en-US', 'Add organisation credits', 'Off', 'Small credit top-up', 'credits'],
      ['en-GB', 'Add organisation credits', 'Off', 'Small credit top-up', 'credits'],
      ['de', 'Organisationsguthaben aufladen', 'Aus', 'Kleine Credit-Aufladung', 'Credits'],
      ['es', 'Añadir créditos a la organización', 'Desactivada', 'Recarga pequeña de créditos', 'créditos'],
      ['fr', 'Ajouter des crédits à l’organisation', 'Désactivée', 'Petite recharge de crédits', 'crédits'],
      ['it', 'Aggiungi crediti all’organizzazione', 'Disattivata', 'Ricarica piccola di crediti', 'crediti'],
    ] as const;

    for (const [locale, fundingTitle, autoTopUpStatus, offerName, creditUnit] of cases) {
      const result = buildBillingCreditsProjection({
        credential,
        collection,
        viewer: viewer(true),
        period,
        data: productionFreshAccountData(),
        now,
        locale,
      });

      if (result.viewer.role !== 'billing_manager' || !result.funding_policy) {
        throw new Error('Expected manager funding actions');
      }
      const offer = result.funding_policy.offers[0]!;
      expect(result.funding_policy.title).toBe(fundingTitle);
      expect(result.automatic_top_up.display_status).toBe(autoTopUpStatus);
      expect(offer.name).toBe(offerName);
      expect(offer.credits_received.display).toContain(creditUnit);
      expect(offer.description).not.toMatch(/automatic top-up stays off|uoa/i);
      expect(result.automatic_top_up.options[0]?.setup_action?.label).not.toMatch(/uoa/i);
    }
  });


  it('keeps English as the default when no customer locale is supplied', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: projectionData(),
      now,
    });

    expect(result.credit_balance.label).toBe('Remaining credits');
    expect(result.recent_entries[0]?.label).toBe('Credits added from DeepWater');
  });


  it('validates the production-provisioned manager projection for a fresh zero-balance team', () => {
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data: productionFreshAccountData(),
      now,
    });

    expect(() => assertBillingCreditsContract(result)).not.toThrow();
  });


  it('uses a fresh Stripe card summary and exposes expiry only when verified', () => {
    const data = projectionData();
    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: viewer(true),
      period,
      data,
      now,
      actionReadiness: {
        executableCatalogIds: new Set(),
        paymentMethodReady: false,
        paymentMethodVerified: true,
        paymentMethodExpired: true,
        paymentMethodSummary: { brand: 'Mastercard', last4: '1881' },
        topUpCheckoutReady: false,
        resumableTopUpOfferId: null,
        setupCheckoutReady: false,
        disableReady: false,
        recoverReady: true,
      },
    });

    expect(result.viewer.role).toBe('billing_manager');
    if (result.viewer.role !== 'billing_manager') throw new Error('Expected manager view');
    expect(result.automatic_top_up.payment_method).toEqual({
      status: 'expired',
      display: 'Mastercard ending in 1881',
    });
  });


  it('labels only the exact pending offer as Continue payment for a different manager', () => {
    const data = productionFreshAccountData();
    const resumableOffer = data.policy?.topUpOffers[0];
    const resumableCatalog = data.catalogs.find(
      (catalog) =>
        catalog.key === resumableOffer?.catalogKey &&
        catalog.version === resumableOffer.catalogVersion,
    );
    if (!resumableOffer || !resumableCatalog) {
      throw new Error('Expected the first top-up offer and its catalog');
    }
    data.unresolvedTopUpCheckouts = [
      {
        id: 'checkout_pending',
        accountId: collection.account.id,
        creditAccountId: data.creditAccount.id,
        customerId: data.creditAccount.customerId,
        catalogId: resumableCatalog.id,
        serviceId: service.id,
        appKeyId: credential.id,
        offerId: resumableOffer.id,
        paymentAmountMinor: resumableOffer.paymentAmountMinor,
        creditsReceivedMicrocredits: resumableOffer.creditsReceivedMicrocredits,
        currency: 'USD',
        successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64),
        stripeCheckoutSessionId: 'cs_pending',
        status: 'OPEN',
      },
    ] as never;

    const result = buildBillingCreditsProjection({
      credential,
      collection,
      viewer: { ...viewer(true), userId: 'different_manager' },
      period,
      data,
      now,
      actionReadiness: {
        executableCatalogIds: new Set([resumableCatalog.id]),
        paymentMethodReady: false,
        topUpCheckoutReady: false,
        resumableTopUpOfferId: resumableOffer.id,
        setupCheckoutReady: false,
        disableReady: false,
        recoverReady: false,
      },
    });

    if (result.viewer.role !== 'billing_manager' || !result.funding_policy) {
      throw new Error('Expected manager funding actions');
    }
    const [firstOffer, ...otherOffers] = result.funding_policy.offers;
    expect(firstOffer).toMatchObject({
      id: resumableOffer.id,
      available: true,
      action: {
        label: 'Continue payment',
        enabled: true,
        request: {
          method: 'POST',
          path: '/billing/v1/credits/top-up-checkout',
          body: {
            product: service.identifier,
            organisation_id: 'org_1',
            team_id: 'team_1',
            user_id: 'different_manager',
            offer_id: resumableOffer.id,
          },
        },
      },
    });
    expect(otherOffers.every((candidate) => !candidate.available)).toBe(true);
    expect(
      otherOffers.every((candidate) =>
        candidate.unavailable_reason?.startsWith('A payment is already in progress.'),
      ),
    ).toBe(true);
  });


});

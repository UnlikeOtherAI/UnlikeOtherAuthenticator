import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText, formatBillingCopy, type BillingCopyPluralForms } from './billing-copy-locale.js';

export type BillingSubscriptionCopy = Readonly<{
  previewTitle: string;
  chooseCancellation: string;
  currentOnlyLabel: string;
  keepOtherProducts: string;
  cancelRelatedLabel: string;
  alsoCancelProducts: string;
  thisSubscriptionEnds: string;
  noSeparateSubscription: string;
  confirmCancellation: string;
  cancellationScheduled: string;
  oneSubscriptionEnds: string;
  manySubscriptionsEnd: BillingCopyPluralForms;
  noSeparateSubscriptionCanceled: string;
}>;

export const BILLING_SUBSCRIPTION_COPY = {
  cs: {
    previewTitle: 'Zrušit předplatné služby {name}?',
    chooseCancellation: 'Vyberte, zda chcete zrušit jen tuto službu, nebo také další služby, které tým používá přímo.',
    currentOnlyLabel: 'Zrušit pouze službu {name}',
    keepOtherProducts: 'Ostatní přímá předplatná týmu zůstanou aktivní.',
    cancelRelatedLabel: 'Zrušit všechna související přímá předplatná',
    alsoCancelProducts: 'Zrušit také: {products}.',
    thisSubscriptionEnds: 'Toto předplatné skončí na konci aktuálního období.',
    noSeparateSubscription: 'Nepřímo používané služby nemají samostatné předplatné ke zrušení.',
    confirmCancellation: 'Potvrdit zrušení',
    cancellationScheduled: 'Zrušení je naplánováno',
    oneSubscriptionEnds: '1 přímé předplatné skončí na konci aktuálního období.',
    manySubscriptionsEnd: { one: '{count} přímé předplatné skončí na konci aktuálního období.', few: '{count} přímá předplatná skončí na konci aktuálního období.', other: '{count} přímých předplatných skončí na konci aktuálního období.' },
    noSeparateSubscriptionCanceled: 'Žádné samostatné předplatné nebylo zrušeno.',
  },
  'en-US': {
    previewTitle: 'Cancel {name}?',
    chooseCancellation: 'Choose whether to cancel only this product or every related product your team subscribes to directly.',
    currentOnlyLabel: 'Cancel {name} only',
    keepOtherProducts: 'Keep your team’s other direct product subscriptions active.',
    cancelRelatedLabel: 'Cancel all related direct subscriptions',
    alsoCancelProducts: 'Also cancel: {products}.',
    thisSubscriptionEnds: 'This subscription will end at the end of its current billing period.',
    noSeparateSubscription: 'Indirectly used products do not have a separate subscription to cancel.',
    confirmCancellation: 'Confirm cancellation',
    cancellationScheduled: 'Cancellation scheduled',
    oneSubscriptionEnds: 'The subscription will end at the end of its current billing period.',
    manySubscriptionsEnd: { one: '{count} direct subscription will end at the end of its current billing period.', other: '{count} direct subscriptions will end at the end of their current billing periods.' },
    noSeparateSubscriptionCanceled: 'No separate subscription was canceled.',
  },
  'en-GB': {
    previewTitle: 'Cancel {name}?',
    chooseCancellation: 'Choose whether to cancel only this product or every related product your team subscribes to directly.',
    currentOnlyLabel: 'Cancel {name} only',
    keepOtherProducts: 'Keep your team’s other direct product subscriptions active.',
    cancelRelatedLabel: 'Cancel all related direct subscriptions',
    alsoCancelProducts: 'Also cancel: {products}.',
    thisSubscriptionEnds: 'This subscription will end at the end of its current billing period.',
    noSeparateSubscription: 'Indirectly used products do not have a separate subscription to cancel.',
    confirmCancellation: 'Confirm cancellation',
    cancellationScheduled: 'Cancellation scheduled',
    oneSubscriptionEnds: 'The subscription will end at the end of its current billing period.',
    manySubscriptionsEnd: { one: '{count} direct subscription will end at the end of its current billing period.', other: '{count} direct subscriptions will end at the end of their current billing periods.' },
    noSeparateSubscriptionCanceled: 'No separate subscription was cancelled.',
  },
  de: {
    previewTitle: '{name} kündigen?',
    chooseCancellation: 'Wählen Sie, ob Sie nur dieses Produkt oder alle zugehörigen direkt abonnierten Teamprodukte kündigen möchten.',
    currentOnlyLabel: 'Nur {name} kündigen',
    keepOtherProducts: 'Die anderen direkten Produktabonnements Ihres Teams bleiben aktiv.',
    cancelRelatedLabel: 'Alle zugehörigen direkten Abonnements kündigen',
    alsoCancelProducts: 'Ebenfalls kündigen: {products}.',
    thisSubscriptionEnds: 'Dieses Abonnement endet zum Ende des aktuellen Abrechnungszeitraums.',
    noSeparateSubscription: 'Indirekt genutzte Produkte haben kein separates kündbares Abonnement.',
    confirmCancellation: 'Kündigung bestätigen',
    cancellationScheduled: 'Kündigung vorgemerkt',
    oneSubscriptionEnds: 'Das Abonnement endet zum Ende des aktuellen Abrechnungszeitraums.',
    manySubscriptionsEnd: { one: '{count} direktes Abonnement endet zum Ende des aktuellen Abrechnungszeitraums.', other: '{count} direkte Abonnements enden zum Ende des aktuellen Abrechnungszeitraums.' },
    noSeparateSubscriptionCanceled: 'Es wurde kein separates Abonnement gekündigt.',
  },
  es: {
    previewTitle: '¿Cancelar {name}?',
    chooseCancellation: 'Elige si quieres cancelar solo este producto o todos los productos relacionados a los que tu equipo está suscrito directamente.',
    currentOnlyLabel: 'Cancelar solo {name}',
    keepOtherProducts: 'Las demás suscripciones directas de productos del equipo seguirán activas.',
    cancelRelatedLabel: 'Cancelar todas las suscripciones directas relacionadas',
    alsoCancelProducts: 'Cancelar también: {products}.',
    thisSubscriptionEnds: 'Esta suscripción terminará al final del periodo de facturación actual.',
    noSeparateSubscription: 'Los productos de uso indirecto no tienen una suscripción independiente que cancelar.',
    confirmCancellation: 'Confirmar cancelación',
    cancellationScheduled: 'Cancelación programada',
    oneSubscriptionEnds: 'La suscripción terminará al final del periodo de facturación actual.',
    manySubscriptionsEnd: { one: '{count} suscripción directa terminará al final del periodo de facturación actual.', other: '{count} suscripciones directas terminarán al final de sus periodos de facturación actuales.' },
    noSeparateSubscriptionCanceled: 'No se canceló ninguna suscripción independiente.',
  },
  fr: {
    previewTitle: 'Résilier {name} ?',
    chooseCancellation: 'Choisissez de résilier uniquement ce produit ou tous les produits associés auxquels votre équipe est directement abonnée.',
    currentOnlyLabel: 'Résilier uniquement {name}',
    keepOtherProducts: 'Les autres abonnements directs de votre équipe resteront actifs.',
    cancelRelatedLabel: 'Résilier tous les abonnements directs associés',
    alsoCancelProducts: 'Résilier aussi : {products}.',
    thisSubscriptionEnds: 'Cet abonnement prendra fin à la fin de la période de facturation en cours.',
    noSeparateSubscription: 'Les produits utilisés indirectement n’ont pas d’abonnement distinct à résilier.',
    confirmCancellation: 'Confirmer la résiliation',
    cancellationScheduled: 'Résiliation programmée',
    oneSubscriptionEnds: 'L’abonnement prendra fin à la fin de la période de facturation en cours.',
    manySubscriptionsEnd: { one: '{count} abonnement direct prendra fin à la fin de sa période de facturation en cours.', other: '{count} abonnements directs prendront fin à la fin de leur période de facturation en cours.' },
    noSeparateSubscriptionCanceled: 'Aucun abonnement distinct n’a été résilié.',
  },
  it: {
    previewTitle: 'Annullare {name}?',
    chooseCancellation: 'Scegli se annullare solo questo prodotto o tutti i prodotti correlati a cui il team è abbonato direttamente.',
    currentOnlyLabel: 'Annulla solo {name}',
    keepOtherProducts: 'Gli altri abbonamenti diretti del team resteranno attivi.',
    cancelRelatedLabel: 'Annulla tutti gli abbonamenti diretti correlati',
    alsoCancelProducts: 'Annulla anche: {products}.',
    thisSubscriptionEnds: 'L’abbonamento terminerà alla fine del periodo di fatturazione corrente.',
    noSeparateSubscription: 'I prodotti usati indirettamente non hanno un abbonamento separato da annullare.',
    confirmCancellation: 'Conferma annullamento',
    cancellationScheduled: 'Annullamento programmato',
    oneSubscriptionEnds: 'L’abbonamento terminerà alla fine del periodo di fatturazione corrente.',
    manySubscriptionsEnd: { one: '{count} abbonamento diretto terminerà alla fine del periodo di fatturazione corrente.', other: '{count} abbonamenti diretti termineranno alla fine dei rispettivi periodi di fatturazione correnti.' },
    noSeparateSubscriptionCanceled: 'Nessun abbonamento separato è stato annullato.',
  },
} satisfies BillingLocaleCatalog<BillingSubscriptionCopy>;

export function billingSubscriptionCopy(locale?: BillingCustomerLocale): BillingSubscriptionCopy {
  return billingLocaleText(BILLING_SUBSCRIPTION_COPY, locale);
}

export function billingSubscriptionText(
  text: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return formatBillingCopy(text, values);
}

import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText } from './billing-copy-locale.js';

export type BillingCreditPurchaseState =
  | 'open'
  | 'processing'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'needs_review';

export type BillingPaymentStateCopy = Readonly<{ title: string; message: string }>;
export type BillingPaymentCopy = Readonly<Record<BillingCreditPurchaseState, BillingPaymentStateCopy>>;

export const BILLING_PAYMENT_COPY = {
  cs: {
    open: { title: 'Platba čeká na dokončení', message: 'Dokončete platbu v otevřeném platebním okně.' },
    processing: { title: 'Platbu ověřujeme', message: 'Platbu ještě ověřujeme.' },
    requires_action: { title: 'Potvrďte platbu', message: 'Vaše banka potřebuje, abyste tuto platbu potvrdili. Vraťte se do platebního okna a dokončete ji.' },
    succeeded: { title: 'Platba potvrzena', message: 'Platba je potvrzená. Kredity jsou připravené.' },
    failed: { title: 'Platba se nepodařila', message: 'Zkontrolujte údaje o kartě nebo u banky, než zahájíte další nákup.' },
    expired: { title: 'Platba vypršela', message: 'Platební okno vypršelo. Až budete připraveni, můžete zahájit nový nákup.' },
    needs_review: { title: 'Stav platby zatím nelze ověřit', message: 'Stav platby teď nemůžeme ověřit. Ověřte ho znovu za chvíli.' },
  },
  'en-US': {
    open: { title: 'Payment not complete', message: 'Finish your payment in the open checkout.' },
    processing: { title: 'Checking your payment', message: 'We’re still checking your payment.' },
    requires_action: { title: 'Confirm your payment', message: 'Your bank needs you to confirm this payment. Return to checkout to finish.' },
    succeeded: { title: 'Payment confirmed', message: 'Your payment is confirmed. Your credits are ready.' },
    failed: { title: 'Payment didn’t go through', message: 'Check your card or bank details before starting another purchase.' },
    expired: { title: 'Checkout expired', message: 'This checkout expired. Start a new purchase when you’re ready.' },
    needs_review: { title: 'Payment status unavailable', message: 'We can’t verify the payment right now. Check again in a little while.' },
  },
  'en-GB': {
    open: { title: 'Payment not complete', message: 'Finish your payment in the open checkout.' },
    processing: { title: 'Checking your payment', message: 'We’re still checking your payment.' },
    requires_action: { title: 'Confirm your payment', message: 'Your bank needs you to confirm this payment. Return to checkout to finish.' },
    succeeded: { title: 'Payment confirmed', message: 'Your payment is confirmed. Your credits are ready.' },
    failed: { title: 'Payment didn’t go through', message: 'Check your card or bank details before starting another purchase.' },
    expired: { title: 'Checkout expired', message: 'This checkout expired. Start a new purchase when you’re ready.' },
    needs_review: { title: 'Payment status unavailable', message: 'We can’t verify the payment right now. Check again in a little while.' },
  },
  de: {
    open: { title: 'Zahlung noch nicht abgeschlossen', message: 'Schließen Sie die Zahlung im geöffneten Checkout ab.' },
    processing: { title: 'Zahlung wird geprüft', message: 'Wir prüfen Ihre Zahlung noch.' },
    requires_action: { title: 'Zahlung bestätigen', message: 'Ihre Bank benötigt eine Bestätigung. Kehren Sie zum Checkout zurück, um die Zahlung abzuschließen.' },
    succeeded: { title: 'Zahlung bestätigt', message: 'Ihre Zahlung ist bestätigt. Ihre Credits sind verfügbar.' },
    failed: { title: 'Zahlung fehlgeschlagen', message: 'Prüfen Sie Ihre Karten- oder Bankdaten, bevor Sie einen weiteren Kauf starten.' },
    expired: { title: 'Checkout abgelaufen', message: 'Dieser Checkout ist abgelaufen. Starten Sie einen neuen Kauf, wenn Sie bereit sind.' },
    needs_review: { title: 'Zahlungsstatus nicht verfügbar', message: 'Wir können die Zahlung gerade nicht prüfen. Versuchen Sie es in Kürze erneut.' },
  },
  es: {
    open: { title: 'Pago sin completar', message: 'Termina el pago en la página de pago abierta.' },
    processing: { title: 'Comprobando el pago', message: 'Todavía estamos comprobando el pago.' },
    requires_action: { title: 'Confirma el pago', message: 'Tu banco necesita que confirmes este pago. Vuelve a la página de pago para terminar.' },
    succeeded: { title: 'Pago confirmado', message: 'El pago está confirmado. Tus créditos ya están disponibles.' },
    failed: { title: 'No se pudo completar el pago', message: 'Comprueba los datos de tu tarjeta o banco antes de iniciar otra compra.' },
    expired: { title: 'La página de pago ha caducado', message: 'Esta página de pago ha caducado. Inicia una nueva compra cuando quieras.' },
    needs_review: { title: 'Estado del pago no disponible', message: 'Ahora no podemos comprobar el pago. Vuelve a comprobarlo dentro de un momento.' },
  },
  fr: {
    open: { title: 'Paiement non terminé', message: 'Terminez le paiement dans la page de paiement ouverte.' },
    processing: { title: 'Vérification du paiement', message: 'Nous vérifions encore votre paiement.' },
    requires_action: { title: 'Confirmez votre paiement', message: 'Votre banque doit confirmer ce paiement. Revenez à la page de paiement pour le terminer.' },
    succeeded: { title: 'Paiement confirmé', message: 'Votre paiement est confirmé. Vos crédits sont disponibles.' },
    failed: { title: 'Le paiement a échoué', message: 'Vérifiez les informations de votre carte ou de votre banque avant de lancer un autre achat.' },
    expired: { title: 'La page de paiement a expiré', message: 'Cette page de paiement a expiré. Lancez un nouvel achat quand vous le souhaitez.' },
    needs_review: { title: 'Statut du paiement indisponible', message: 'Nous ne pouvons pas vérifier le paiement pour le moment. Réessayez dans quelques instants.' },
  },
  it: {
    open: { title: 'Pagamento non completato', message: 'Completa il pagamento nella pagina di pagamento aperta.' },
    processing: { title: 'Verifica del pagamento', message: 'Stiamo ancora verificando il pagamento.' },
    requires_action: { title: 'Conferma il pagamento', message: 'La tua banca deve confermare questo pagamento. Torna alla pagina di pagamento per completarlo.' },
    succeeded: { title: 'Pagamento confermato', message: 'Il pagamento è confermato. I tuoi crediti sono disponibili.' },
    failed: { title: 'Pagamento non riuscito', message: 'Controlla i dati della carta o della banca prima di iniziare un altro acquisto.' },
    expired: { title: 'La pagina di pagamento è scaduta', message: 'Questa pagina di pagamento è scaduta. Avvia un nuovo acquisto quando vuoi.' },
    needs_review: { title: 'Stato del pagamento non disponibile', message: 'Al momento non possiamo verificare il pagamento. Riprova tra poco.' },
  },
} satisfies BillingLocaleCatalog<BillingPaymentCopy>;

export function billingCreditPaymentCopy(
  locale?: BillingCustomerLocale,
): BillingPaymentCopy {
  return billingLocaleText(BILLING_PAYMENT_COPY, locale);
}

export function billingPaymentCopy(
  state: BillingCreditPurchaseState,
  locale?: BillingCustomerLocale,
): BillingPaymentStateCopy {
  return billingCreditPaymentCopy(locale)[state];
}

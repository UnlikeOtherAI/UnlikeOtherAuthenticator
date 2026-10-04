import type {
  BillingCreditPurchaseState as ProtocolBillingCreditPurchaseState,
} from '@unlikeotherai/billing-statement-protocol';
import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText } from './billing-copy-locale.js';

export type BillingCreditPurchaseState = ProtocolBillingCreditPurchaseState;

export type BillingPaymentStateCopy = Readonly<{ title: string; message: string }>;
export type BillingPaymentCopy = Readonly<Record<BillingCreditPurchaseState, BillingPaymentStateCopy>>;

export const BILLING_PAYMENT_COPY = {
  cs: {
    open: { title: 'Platba čeká na dokončení', message: 'Platbu znovu otevřete a dokončete ji.' },
    processing: { title: 'Platbu ověřujeme', message: 'Platbu ještě ověřujeme.' },
    requires_action: { title: 'Potvrďte platbu', message: 'Vaše banka potřebuje, abyste tuto platbu potvrdili. Vraťte se na platební stránku a dokončete ji.' },
    succeeded: { title: 'Platba potvrzena', message: 'Platba je potvrzená. Kredity byly připsány.' },
    failed: { title: 'Platba se nepodařila', message: 'Zkontrolujte údaje o kartě nebo u banky, než zahájíte další nákup.' },
    expired: { title: 'Platba vypršela', message: 'Platbu už nelze dokončit. Až budete připraveni, můžete začít znovu.' },
    needs_review: { title: 'Stav platby zatím nelze ověřit', message: 'Stav platby teď nemůžeme ověřit. Ověřte ho znovu za chvíli.' },
  },
  'en-US': {
    open: { title: 'Payment not complete', message: 'Open the payment again to finish it.' },
    processing: { title: 'Checking your payment', message: 'We’re still checking your payment.' },
    requires_action: { title: 'Confirm your payment', message: 'Your bank needs you to confirm this payment. Return to the payment page to finish.' },
    succeeded: { title: 'Payment confirmed', message: 'Your payment is confirmed. Credits were added.' },
    failed: { title: 'Payment didn’t go through', message: 'Check your card or bank details before starting another purchase.' },
    expired: { title: 'Payment expired', message: 'This payment can no longer be completed. Start again when you’re ready.' },
    needs_review: { title: 'Payment status unavailable', message: 'We can’t verify the payment right now. Check again in a little while.' },
  },
  'en-GB': {
    open: { title: 'Payment not complete', message: 'Open the payment again to finish it.' },
    processing: { title: 'Checking your payment', message: 'We’re still checking your payment.' },
    requires_action: { title: 'Confirm your payment', message: 'Your bank needs you to confirm this payment. Return to the payment page to finish.' },
    succeeded: { title: 'Payment confirmed', message: 'Your payment is confirmed. Credits were added.' },
    failed: { title: 'Payment didn’t go through', message: 'Check your card or bank details before starting another purchase.' },
    expired: { title: 'Payment expired', message: 'This payment can no longer be completed. Start again when you’re ready.' },
    needs_review: { title: 'Payment status unavailable', message: 'We can’t verify the payment right now. Check again in a little while.' },
  },
  de: {
    open: { title: 'Zahlung noch nicht abgeschlossen', message: 'Öffnen Sie die Zahlung erneut, um sie abzuschließen.' },
    processing: { title: 'Zahlung wird geprüft', message: 'Wir prüfen Ihre Zahlung noch.' },
    requires_action: { title: 'Zahlung bestätigen', message: 'Ihre Bank benötigt eine Bestätigung. Kehren Sie zur Zahlungsseite zurück, um die Zahlung abzuschließen.' },
    succeeded: { title: 'Zahlung bestätigt', message: 'Ihre Zahlung ist bestätigt. Credits wurden gutgeschrieben.' },
    failed: { title: 'Zahlung fehlgeschlagen', message: 'Prüfen Sie Ihre Karten- oder Bankdaten, bevor Sie einen weiteren Kauf starten.' },
    expired: { title: 'Zahlung abgelaufen', message: 'Diese Zahlung kann nicht mehr abgeschlossen werden. Beginnen Sie erneut, wenn Sie bereit sind.' },
    needs_review: { title: 'Zahlungsstatus nicht verfügbar', message: 'Wir können die Zahlung gerade nicht prüfen. Versuchen Sie es in Kürze erneut.' },
  },
  es: {
    open: { title: 'Pago sin completar', message: 'Vuelve a abrir el pago para terminarlo.' },
    processing: { title: 'Comprobando el pago', message: 'Todavía estamos comprobando el pago.' },
    requires_action: { title: 'Confirma el pago', message: 'Tu banco necesita que confirmes este pago. Vuelve a la página de pago para terminar.' },
    succeeded: { title: 'Pago confirmado', message: 'El pago está confirmado. Los créditos se añadieron.' },
    failed: { title: 'No se pudo completar el pago', message: 'Comprueba los datos de tu tarjeta o banco antes de iniciar otra compra.' },
    expired: { title: 'La página de pago ha caducado', message: 'Esta página de pago ha caducado. Inicia una nueva compra cuando quieras.' },
    needs_review: { title: 'Estado del pago no disponible', message: 'Ahora no podemos comprobar el pago. Vuelve a comprobarlo dentro de un momento.' },
  },
  fr: {
    open: { title: 'Paiement non terminé', message: 'Rouvrez le paiement pour le terminer.' },
    processing: { title: 'Vérification du paiement', message: 'Nous vérifions encore votre paiement.' },
    requires_action: { title: 'Confirmez votre paiement', message: 'Votre banque vous demande de confirmer ce paiement. Revenez à la page de paiement pour le terminer.' },
    succeeded: { title: 'Paiement confirmé', message: 'Votre paiement est confirmé. Les crédits ont été ajoutés.' },
    failed: { title: 'Le paiement a échoué', message: 'Vérifiez les informations de votre carte ou de votre banque avant de lancer un autre achat.' },
    expired: { title: 'La page de paiement a expiré', message: 'Cette page de paiement a expiré. Lancez un nouvel achat quand vous le souhaitez.' },
    needs_review: { title: 'Statut du paiement indisponible', message: 'Nous ne pouvons pas vérifier le paiement pour le moment. Réessayez dans quelques instants.' },
  },
  it: {
    open: { title: 'Pagamento non completato', message: 'Riapri il pagamento per completarlo.' },
    processing: { title: 'Verifica del pagamento', message: 'Stiamo ancora verificando il pagamento.' },
    requires_action: { title: 'Conferma il pagamento', message: 'La tua banca deve confermare questo pagamento. Torna alla pagina di pagamento per completarlo.' },
    succeeded: { title: 'Pagamento confermato', message: 'Il pagamento è confermato. I crediti sono stati aggiunti.' },
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

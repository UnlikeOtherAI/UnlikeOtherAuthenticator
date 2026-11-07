import type { BillingCustomerLocale } from './billing-copy-locale.js';

const copy: Record<BillingCustomerLocale, string> = {
  'en-US': 'Refresh billing in an updated app before starting this payment action.',
  'en-GB': 'Refresh billing in an updated app before starting this payment action.',
  cs: 'Před zahájením této platební akce obnovte účtování v aktualizované aplikaci.',
  de: 'Aktualisieren Sie die Abrechnungsansicht in einer aktuellen App, bevor Sie diese Zahlungsaktion starten.',
  es: 'Actualice la vista de facturación en una aplicación actualizada antes de iniciar esta acción de pago.',
  fr: 'Actualisez la facturation dans une application à jour avant de lancer cette opération de paiement.',
  it: 'Aggiorna la fatturazione in una versione aggiornata dell’app prima di avviare questa operazione di pagamento.',
};
export const billingModeRefreshCopy = (locale: BillingCustomerLocale = 'en-US') => copy[locale];

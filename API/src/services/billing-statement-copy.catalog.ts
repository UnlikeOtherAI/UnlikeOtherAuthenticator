import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText } from './billing-copy-locale.js';

type BillingStatementCopy = Readonly<{
  meteredUsage: string;
  usageDetails: string;
  monthlySubscription: string;
  subscriptionDetails: string;
  seatDetails: string;
  credit: string;
  additionalCharge: string;
  monthlySeats: string;
  prepaidUsage: string;
  prepaidPurchase: string;
  automaticPrepaidPurchase: string;
  cancelledInvoice: string;
  cloudBrowser: string;
  cloudBrowserDetails: string;
}>;

const catalog: BillingLocaleCatalog<BillingStatementCopy> = {
  "cs": {
    "monthlySeats": "Měsíční místa",
    "prepaidUsage": "Předplacená spotřeba",
    "prepaidPurchase": "Nákup kreditů",
    "automaticPrepaidPurchase": "Automatický nákup kreditů",
    "cancelledInvoice": "Zrušení poplatků původní faktury",
    "meteredUsage": "Spotřeba podle využití",
    "usageDetails": "Cena spotřeby za toto fakturační období",
    "monthlySubscription": "Měsíční předplatné",
    "subscriptionDetails": "Cena předplatného za toto fakturační období",
    "seatDetails": "Potvrzená cena míst za toto fakturační období",
    "credit": "Kredit",
    "additionalCharge": "Další poplatek",
    "cloudBrowser": "Cloudový prohlížeč",
    "cloudBrowserDetails": "Cena cloudového prohlížeče za toto fakturační období"
  },
  "en-US": {
    "monthlySeats": "Monthly seats",
    "prepaidUsage": "Prepaid usage",
    "prepaidPurchase": "Prepaid credits purchase",
    "automaticPrepaidPurchase": "Automatic prepaid credits purchase",
    "cancelledInvoice": "Cancellation of original invoice charges",
    "meteredUsage": "Metered usage",
    "usageDetails": "Metered usage charge for this billing period",
    "monthlySubscription": "Monthly subscription",
    "subscriptionDetails": "Subscription charge for this billing period",
    "seatDetails": "Frozen seat charge for this billing period",
    "credit": "Credit",
    "additionalCharge": "Additional charge",
    "cloudBrowser": "Cloud browser",
    "cloudBrowserDetails": "Cloud browser charge for this billing period"
  },
  "en-GB": {
    "monthlySeats": "Monthly seats",
    "prepaidUsage": "Prepaid usage",
    "prepaidPurchase": "Prepaid credits purchase",
    "automaticPrepaidPurchase": "Automatic prepaid credits purchase",
    "cancelledInvoice": "Cancellation of original invoice charges",
    "meteredUsage": "Metered usage",
    "usageDetails": "Metered usage charge for this billing period",
    "monthlySubscription": "Monthly subscription",
    "subscriptionDetails": "Subscription charge for this billing period",
    "seatDetails": "Frozen seat charge for this billing period",
    "credit": "Credit",
    "additionalCharge": "Additional charge",
    "cloudBrowser": "Cloud browser",
    "cloudBrowserDetails": "Cloud browser charge for this billing period"
  },
  "de": {
    "monthlySeats": "Monatliche Plätze",
    "prepaidUsage": "Vorausbezahlte Nutzung",
    "prepaidPurchase": "Kauf von Guthaben",
    "automaticPrepaidPurchase": "Automatischer Guthabenkauf",
    "cancelledInvoice": "Stornierung der ursprünglichen Rechnungsgebühren",
    "meteredUsage": "Nutzungsgebühr",
    "usageDetails": "Nutzungsgebühr für diesen Abrechnungszeitraum",
    "monthlySubscription": "Monatliches Abonnement",
    "subscriptionDetails": "Abonnementgebühr für diesen Abrechnungszeitraum",
    "seatDetails": "Bestätigte Platzgebühr für diesen Abrechnungszeitraum",
    "credit": "Gutschrift",
    "additionalCharge": "Zusätzliche Gebühr",
    "cloudBrowser": "Cloud-Browser",
    "cloudBrowserDetails": "Cloud-Browser-Gebühr für diesen Abrechnungszeitraum"
  },
  "es": {
    "monthlySeats": "Plazas mensuales",
    "prepaidUsage": "Uso prepagado",
    "prepaidPurchase": "Compra de créditos",
    "automaticPrepaidPurchase": "Compra automática de créditos",
    "cancelledInvoice": "Cancelación de los cargos de la factura original",
    "meteredUsage": "Uso medido",
    "usageDetails": "Cargo por uso de este periodo de facturación",
    "monthlySubscription": "Suscripción mensual",
    "subscriptionDetails": "Cargo de suscripción de este periodo de facturación",
    "seatDetails": "Cargo confirmado por plazas de este periodo de facturación",
    "credit": "Crédito",
    "additionalCharge": "Cargo adicional",
    "cloudBrowser": "Navegador en la nube",
    "cloudBrowserDetails": "Cargo del navegador en la nube de este periodo de facturación"
  },
  "fr": {
    "monthlySeats": "Places mensuelles",
    "prepaidUsage": "Utilisation prépayée",
    "prepaidPurchase": "Achat de crédits",
    "automaticPrepaidPurchase": "Achat automatique de crédits",
    "cancelledInvoice": "Annulation des frais de la facture initiale",
    "meteredUsage": "Utilisation mesurée",
    "usageDetails": "Frais d’utilisation pour cette période de facturation",
    "monthlySubscription": "Abonnement mensuel",
    "subscriptionDetails": "Frais d’abonnement pour cette période de facturation",
    "seatDetails": "Frais de places confirmés pour cette période de facturation",
    "credit": "Crédit",
    "additionalCharge": "Frais supplémentaires",
    "cloudBrowser": "Navigateur cloud",
    "cloudBrowserDetails": "Frais du navigateur cloud pour cette période de facturation"
  },
  "it": {
    "monthlySeats": "Posti mensili",
    "prepaidUsage": "Utilizzo prepagato",
    "prepaidPurchase": "Acquisto di crediti",
    "automaticPrepaidPurchase": "Acquisto automatico di crediti",
    "cancelledInvoice": "Annullamento degli addebiti della fattura originale",
    "meteredUsage": "Utilizzo misurato",
    "usageDetails": "Costo di utilizzo per questo periodo di fatturazione",
    "monthlySubscription": "Abbonamento mensile",
    "subscriptionDetails": "Costo dell’abbonamento per questo periodo di fatturazione",
    "seatDetails": "Costo confermato dei posti per questo periodo di fatturazione",
    "credit": "Credito",
    "additionalCharge": "Addebito aggiuntivo",
    "cloudBrowser": "Browser cloud",
    "cloudBrowserDetails": "Costo del browser cloud per questo periodo di fatturazione"
  }
};

export const billingStatementCopy = (locale?: BillingCustomerLocale): BillingStatementCopy =>
  billingLocaleText(catalog, locale);

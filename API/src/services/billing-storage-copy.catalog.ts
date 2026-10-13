import { billingLocaleText, type BillingCustomerLocale, type BillingLocaleCatalog } from './billing-copy-locale.js';

export const STORAGE_CONSENT_VERSION = 'company-storage-auto-expansion-v1';
const COPY = {
  'en-US': {
    consent: 'Authorize automatic monthly storage charges per whole 1 TB block and automatic additional blocks when company usage exceeds capacity. The initial purchase establishes the separate monthly subscription renewal date shown by Stripe; additional blocks are prorated immediately and keep that date. Storage is charged from the first block. This consent does not authorize inference or seat payments.',
    unitPrice: 'Monthly unit price',
  },
  'en-GB': {
    consent: 'Authorise automatic monthly storage charges per whole 1 TB block and automatic additional blocks when company usage exceeds capacity. The initial purchase establishes the separate monthly subscription renewal date shown by Stripe; additional blocks are prorated immediately and keep that date. Storage is charged from the first block. This consent does not authorise inference or seat payments.',
    unitPrice: 'Monthly unit price',
  },
  cs: {
    consent: 'Povoluji automatické měsíční platby za úložiště po celých blocích 1 TB a automatické přidání dalších bloků, když využití firmy překročí kapacitu. První nákup stanoví datum obnovení samostatného měsíčního předplatného zobrazené službou Stripe; další bloky se ihned poměrně vyúčtují a toto datum zachovají. Úložiště se účtuje od prvního bloku. Tento souhlas nepovoluje platby za inferenci ani za uživatelská místa.',
    unitPrice: 'Měsíční cena za blok',
  },
  de: {
    consent: 'Ich genehmige automatische monatliche Speicherzahlungen je ganzem 1-TB-Block und das automatische Hinzufügen weiterer Blöcke, wenn die Nutzung des Unternehmens die Kapazität überschreitet. Der erste Kauf legt das von Stripe angezeigte Verlängerungsdatum des separaten monatlichen Abonnements fest; weitere Blöcke werden sofort anteilig berechnet und behalten dieses Datum. Speicher wird ab dem ersten Block berechnet. Diese Zustimmung genehmigt keine Zahlungen für Inferenz oder Benutzerplätze.',
    unitPrice: 'Monatlicher Preis je Block',
  },
  es: {
    consent: 'Autorizo los cobros mensuales automáticos de almacenamiento por bloques completos de 1 TB y la incorporación automática de bloques adicionales cuando el uso de la empresa supere la capacidad. La compra inicial establece la fecha de renovación de la suscripción mensual independiente que muestra Stripe; los bloques adicionales se cobran proporcionalmente de inmediato y conservan esa fecha. El almacenamiento se cobra desde el primer bloque. Este consentimiento no autoriza pagos por inferencia ni por puestos de usuario.',
    unitPrice: 'Precio mensual por bloque',
  },
  fr: {
    consent: 'J’autorise les paiements mensuels automatiques de stockage par blocs entiers de 1 To et l’ajout automatique de blocs supplémentaires lorsque l’utilisation de l’entreprise dépasse la capacité. L’achat initial fixe la date de renouvellement de l’abonnement mensuel distinct affichée par Stripe ; les blocs supplémentaires sont facturés immédiatement au prorata et conservent cette date. Le stockage est facturé dès le premier bloc. Ce consentement n’autorise aucun paiement pour l’inférence ni pour les places utilisateur.',
    unitPrice: 'Prix mensuel par bloc',
  },
  it: {
    consent: 'Autorizzo gli addebiti mensili automatici per lo spazio di archiviazione in blocchi interi da 1 TB e l’aggiunta automatica di ulteriori blocchi quando l’utilizzo dell’azienda supera la capacità. L’acquisto iniziale stabilisce la data di rinnovo dell’abbonamento mensile separato mostrata da Stripe; i blocchi aggiuntivi vengono addebitati immediatamente in proporzione e mantengono tale data. Lo spazio viene addebitato dal primo blocco. Questo consenso non autorizza pagamenti per l’inferenza o per i posti utente.',
    unitPrice: 'Prezzo mensile per blocco',
  },
} satisfies BillingLocaleCatalog<{ consent: string; unitPrice: string }>;

export function storageCopy(locale?: BillingCustomerLocale) {
  return billingLocaleText(COPY, locale);
}

export function storageCheckoutText(locale: BillingCustomerLocale | undefined, currency: string, amount: bigint) {
  const copy = storageCopy(locale);
  return `${copy.consent} ${copy.unitPrice}: ${currency} ${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}.`;
}

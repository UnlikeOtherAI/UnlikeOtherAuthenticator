import { BillingCreditEntryKind } from '@prisma/client';

import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocaleText, formatBillingCopy } from './billing-copy-locale.js';

export type BillingCreditEntryCopy = Readonly<{
  label: string;
  detail: string;
}>;

export type BillingCreditEntryCopyKey = keyof typeof BillingCreditEntryKind;

type EntryCopyCatalog = Readonly<Record<Exclude<BillingCreditEntryKind,
  'PREPAID_USAGE' | 'SMS_PREPAID_USAGE'>, BillingCreditEntryCopy>>;

export const BILLING_CREDIT_ENTRY_COPY = {
  cs: {
    TOP_UP: { label: 'Kredity přidané službou {product}', detail: 'Ověřená platba přidala {credits} do sdíleného týmového zůstatku.' },
    AUTOMATIC_TOP_UP: { label: 'Automatické dobití týmových kreditů', detail: 'Ověřená automatická platba přidala {credits} do sdíleného týmového zůstatku.' },
    USAGE_SETTLEMENT: { label: 'Využití služby {product}', detail: 'Ověřené využití služby {product} odečetlo {credits}; podrobnosti najdete v přehledu využití.' },
    USAGE_SETTLEMENT_CORRECTION: { label: 'Oprava využití služby {product}', detail: 'Ověřený přehled využití služby {product} změnil sdílený zůstatek o {credits}.' },
    REFUND: { label: 'Vrácení platby za službu {product}', detail: 'Ověřené vrácení platby odečetlo {credits} ze sdíleného týmového zůstatku.' },
    DISPUTE: { label: 'Spor o platbu za službu {product}', detail: 'Ověřený spor o platbu odečetl {credits} ze sdíleného týmového zůstatku.' },
    REFUND_REVERSAL: { label: 'Obnovené kredity', detail: 'Vrácení platby se neprovedlo. {credits} se vrátilo do týmového zůstatku.' },
    DISPUTE_REVERSAL: { label: 'Obnovení kreditů po sporu služby {product}', detail: 'Ověřené obnovení platby ve sporu vrátilo {credits} do sdíleného týmového zůstatku.' },
    ADJUSTMENT: { label: 'Úprava kreditů na účtu', detail: 'Podpora upravila sdílený týmový zůstatek o {credits}.' },
  },
  'en-US': {
    TOP_UP: { label: 'Credits added from {product}', detail: 'A verified payment added {credits} to the shared team balance.' },
    AUTOMATIC_TOP_UP: { label: 'Automatic team credit top-up', detail: 'A verified automatic payment added {credits} to the shared team balance.' },
    USAGE_SETTLEMENT: { label: '{product} usage', detail: 'Verified {product} usage used {credits}. See the usage breakdown for details.' },
    USAGE_SETTLEMENT_CORRECTION: { label: '{product} usage correction', detail: 'A verified {product} usage update changed the shared balance by {credits}.' },
    REFUND: { label: '{product} payment refund', detail: 'A verified refund removed {credits} from the shared team balance.' },
    DISPUTE: { label: '{product} payment dispute', detail: 'A verified payment dispute removed {credits} from the shared team balance.' },
    REFUND_REVERSAL: { label: '{product} refund reversal', detail: 'A failed or canceled refund restored {credits} to the shared team balance.' },
    DISPUTE_REVERSAL: { label: '{product} dispute reinstatement', detail: 'Verified reinstated dispute funds restored {credits} to the shared team balance.' },
    ADJUSTMENT: { label: 'Account credit adjustment', detail: 'Support adjusted the shared team balance by {credits}.' },
  },
  'en-GB': {
    TOP_UP: { label: 'Credits added from {product}', detail: 'A verified payment added {credits} to the shared team balance.' },
    AUTOMATIC_TOP_UP: { label: 'Automatic team credit top-up', detail: 'A verified automatic payment added {credits} to the shared team balance.' },
    USAGE_SETTLEMENT: { label: '{product} usage', detail: 'Verified {product} usage used {credits}. See the usage breakdown for details.' },
    USAGE_SETTLEMENT_CORRECTION: { label: '{product} usage correction', detail: 'A verified {product} usage update changed the shared balance by {credits}.' },
    REFUND: { label: '{product} payment refund', detail: 'A verified refund removed {credits} from the shared team balance.' },
    DISPUTE: { label: '{product} payment dispute', detail: 'A verified payment dispute removed {credits} from the shared team balance.' },
    REFUND_REVERSAL: { label: '{product} refund reversal', detail: 'A failed or cancelled refund restored {credits} to the shared team balance.' },
    DISPUTE_REVERSAL: { label: '{product} dispute reinstatement', detail: 'Verified reinstated dispute funds restored {credits} to the shared team balance.' },
    ADJUSTMENT: { label: 'Account credit adjustment', detail: 'Support adjusted the shared team balance by {credits}.' },
  },
  de: {
    TOP_UP: { label: 'Credits von {product} hinzugefügt', detail: 'Eine bestätigte Zahlung hat {credits} zum gemeinsamen Teamguthaben hinzugefügt.' },
    AUTOMATIC_TOP_UP: { label: 'Automatische Team-Aufladung', detail: 'Eine bestätigte automatische Zahlung hat {credits} zum gemeinsamen Teamguthaben hinzugefügt.' },
    USAGE_SETTLEMENT: { label: 'Nutzung von {product}', detail: 'Die bestätigte Nutzung von {product} hat {credits} verbraucht. Weitere Details finden Sie in der Nutzungsübersicht.' },
    USAGE_SETTLEMENT_CORRECTION: { label: 'Korrektur der {product}-Nutzung', detail: 'Eine bestätigte Nutzungsaktualisierung von {product} hat das gemeinsame Guthaben um {credits} geändert.' },
    REFUND: { label: 'Rückerstattung für {product}', detail: 'Eine bestätigte Rückerstattung hat {credits} vom gemeinsamen Teamguthaben abgezogen.' },
    DISPUTE: { label: 'Zahlungsstreitfall für {product}', detail: 'Ein bestätigter Zahlungsstreitfall hat {credits} vom gemeinsamen Teamguthaben abgezogen.' },
    REFUND_REVERSAL: { label: 'Rücknahme einer Rückerstattung für {product}', detail: 'Eine fehlgeschlagene oder stornierte Rückerstattung hat {credits} dem gemeinsamen Teamguthaben wieder gutgeschrieben.' },
    DISPUTE_REVERSAL: { label: 'Wiederherstellung nach Zahlungsstreitfall für {product}', detail: 'Bestätigte wiederhergestellte Streitfallbeträge haben {credits} dem gemeinsamen Teamguthaben wieder gutgeschrieben.' },
    ADJUSTMENT: { label: 'Guthabenkorrektur', detail: 'Der Support hat das gemeinsame Teamguthaben um {credits} angepasst.' },
  },
  es: {
    TOP_UP: { label: 'Créditos añadidos desde {product}', detail: 'Un pago verificado añadió {credits} al saldo compartido del equipo.' },
    AUTOMATIC_TOP_UP: { label: 'Recarga automática de créditos del equipo', detail: 'Un pago automático verificado añadió {credits} al saldo compartido del equipo.' },
    USAGE_SETTLEMENT: { label: 'Uso de {product}', detail: 'El uso verificado de {product} consumió {credits}. Consulta el desglose de uso para ver más detalles.' },
    USAGE_SETTLEMENT_CORRECTION: { label: 'Corrección del uso de {product}', detail: 'Una actualización verificada del uso de {product} cambió el saldo compartido en {credits}.' },
    REFUND: { label: 'Reembolso de {product}', detail: 'Un reembolso verificado retiró {credits} del saldo compartido del equipo.' },
    DISPUTE: { label: 'Disputa de pago de {product}', detail: 'Una disputa de pago verificada retiró {credits} del saldo compartido del equipo.' },
    REFUND_REVERSAL: { label: 'Reversión del reembolso de {product}', detail: 'Un reembolso fallido o cancelado devolvió {credits} al saldo compartido del equipo.' },
    DISPUTE_REVERSAL: { label: 'Restitución tras disputa de {product}', detail: 'La restitución verificada de fondos de una disputa devolvió {credits} al saldo compartido del equipo.' },
    ADJUSTMENT: { label: 'Ajuste de créditos de la cuenta', detail: 'El equipo de soporte ajustó el saldo compartido en {credits}.' },
  },
  fr: {
    TOP_UP: { label: 'Crédits ajoutés par {product}', detail: 'Un paiement vérifié a ajouté {credits} au solde partagé de l’équipe.' },
    AUTOMATIC_TOP_UP: { label: 'Recharge automatique des crédits de l’équipe', detail: 'Un paiement automatique vérifié a ajouté {credits} au solde partagé de l’équipe.' },
    USAGE_SETTLEMENT: { label: 'Utilisation de {product}', detail: 'L’utilisation vérifiée de {product} a consommé {credits}. Consultez le détail de l’utilisation pour en savoir plus.' },
    USAGE_SETTLEMENT_CORRECTION: { label: 'Correction de l’utilisation de {product}', detail: 'Une mise à jour vérifiée de l’utilisation de {product} a modifié le solde partagé de {credits}.' },
    REFUND: { label: 'Remboursement de {product}', detail: 'Un remboursement vérifié a retiré {credits} du solde partagé de l’équipe.' },
    DISPUTE: { label: 'Litige de paiement pour {product}', detail: 'Un litige de paiement vérifié a retiré {credits} du solde partagé de l’équipe.' },
    REFUND_REVERSAL: { label: 'Annulation du remboursement de {product}', detail: 'Un remboursement échoué ou annulé a rétabli {credits} dans le solde partagé de l’équipe.' },
    DISPUTE_REVERSAL: { label: 'Rétablissement après litige pour {product}', detail: 'Le rétablissement vérifié des fonds contestés a rendu {credits} au solde partagé de l’équipe.' },
    ADJUSTMENT: { label: 'Ajustement des crédits du compte', detail: 'L’assistance a ajusté le solde partagé de {credits}.' },
  },
  it: {
    TOP_UP: { label: 'Crediti aggiunti da {product}', detail: 'Un pagamento verificato ha aggiunto {credits} al saldo condiviso del team.' },
    AUTOMATIC_TOP_UP: { label: 'Ricarica automatica dei crediti del team', detail: 'Un pagamento automatico verificato ha aggiunto {credits} al saldo condiviso del team.' },
    USAGE_SETTLEMENT: { label: 'Utilizzo di {product}', detail: 'L’utilizzo verificato di {product} ha consumato {credits}. Consulta il dettaglio dell’utilizzo per saperne di più.' },
    USAGE_SETTLEMENT_CORRECTION: { label: 'Correzione dell’utilizzo di {product}', detail: 'Un aggiornamento verificato dell’utilizzo di {product} ha modificato il saldo condiviso di {credits}.' },
    REFUND: { label: 'Rimborso di {product}', detail: 'Un rimborso verificato ha rimosso {credits} dal saldo condiviso del team.' },
    DISPUTE: { label: 'Contestazione del pagamento di {product}', detail: 'Una contestazione di pagamento verificata ha rimosso {credits} dal saldo condiviso del team.' },
    REFUND_REVERSAL: { label: 'Storno del rimborso di {product}', detail: 'Un rimborso non riuscito o annullato ha ripristinato {credits} nel saldo condiviso del team.' },
    DISPUTE_REVERSAL: { label: 'Ripristino dopo contestazione di {product}', detail: 'Il ripristino verificato dei fondi contestati ha restituito {credits} al saldo condiviso del team.' },
    ADJUSTMENT: { label: 'Rettifica dei crediti del conto', detail: 'L’assistenza ha rettificato il saldo condiviso di {credits}.' },
  },
} satisfies Record<BillingCustomerLocale, EntryCopyCatalog>;

export function billingCreditEntryCopy(
  kind: BillingCreditEntryKind,
  locale?: BillingCustomerLocale,
): BillingCreditEntryCopy {
  return billingLocaleText(BILLING_CREDIT_ENTRY_COPY, locale)[
    kind === BillingCreditEntryKind.PREPAID_USAGE || kind === BillingCreditEntryKind.SMS_PREPAID_USAGE
      ? BillingCreditEntryKind.USAGE_SETTLEMENT : kind
  ];
}

export function formatBillingCreditEntryCopy(
  kind: BillingCreditEntryKind,
  locale: BillingCustomerLocale | undefined,
  values: { product: string; credits: string },
): BillingCreditEntryCopy {
  const copy = billingCreditEntryCopy(kind, locale);
  return {
    label: formatBillingCopy(copy.label, values),
    detail: formatBillingCopy(copy.detail, values),
  };
}

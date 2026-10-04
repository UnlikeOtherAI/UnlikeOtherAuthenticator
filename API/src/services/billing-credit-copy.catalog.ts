import type {
  BillingCopyPluralForms,
  BillingCustomerLocale,
} from './billing-copy-locale.js';
import { billingLocaleText, billingPluralCopy } from './billing-copy-locale.js';

export type BillingCreditCopy = Readonly<{
  conversionDescription: string;
  balanceLabel: string;
  balanceDescription: string;
  pendingCreditsLabel: BillingCopyPluralForms;
  pendingCreditsDescription: string;
  managerViewerDescription: string;
  memberViewerDescription: string;
  creditOfferNames: Readonly<Record<'credits_usd_10' | 'credits_usd_25' | 'credits_usd_50' | 'credits_usd_100', string>>;
  oneTimeOfferDescription: string;
  smallestOfferHint: string;
}>;

export const BILLING_CREDIT_COPY = {
  cs: {
    conversionDescription:
      '1 000 kredit vždy odpovídá 1,00 USD. Spotřeba se počítá přesně, odečítají se však pouze celé kredity.',
    balanceLabel: 'Zbývající kredity',
    balanceDescription: 'Tento zůstatek sdílí celý tým napříč připojenými službami.',
    pendingCreditsLabel: { one: 'Čeká {count} dobití', few: 'Čekají {count} dobití', other: 'Čeká {count} dobití' },
    pendingCreditsDescription:
      'Čekající kredity se přičtou až po ověření platby a nejsou součástí zbývajícího zůstatku.',
    managerViewerDescription: 'Zobrazí se vám využití celého týmu a můžete spravovat dobíjení.',
    memberViewerDescription: 'Zobrazí se vám vaše využití a souhrnné údaje o týmu.',
    creditOfferNames: { credits_usd_10: 'Malé dobití kreditů', credits_usd_25: 'Střední dobití kreditů', credits_usd_50: 'Velké dobití kreditů', credits_usd_100: 'Největší dobití kreditů' },
    oneTimeOfferDescription: 'Jednorázové dobití. Automatické dobíjení zůstane vypnuté.',
    smallestOfferHint: 'Začněte nejmenším dostupným dobitím.',
  },
  'en-US': {
    conversionDescription:
      '1,000 credits always equal US$1.00. Usage is counted exactly, but only whole credits are deducted.',
    balanceLabel: 'Remaining credits',
    balanceDescription: 'Your team shares this balance across connected services.',
    pendingCreditsLabel: { one: '{count} top-up pending', other: '{count} top-ups pending' },
    pendingCreditsDescription:
      'Pending credits are added after payment is verified. They are not included in the remaining balance.',
    managerViewerDescription: 'You can see your team’s usage and manage credit top-ups.',
    memberViewerDescription: 'You can see your usage and a summary of team usage.',
    creditOfferNames: { credits_usd_10: 'Small credit top-up', credits_usd_25: 'Medium credit top-up', credits_usd_50: 'Large credit top-up', credits_usd_100: 'Extra-large credit top-up' },
    oneTimeOfferDescription: 'One-time purchase. Automatic top-up stays off.',
    smallestOfferHint: 'Start with the smallest available top-up.',
  },
  'en-GB': {
    conversionDescription:
      '1,000 credits always equal US$1.00. Usage is counted exactly, but only whole credits are deducted.',
    balanceLabel: 'Remaining credits',
    balanceDescription: 'Your team shares this balance across connected services.',
    pendingCreditsLabel: { one: '{count} top-up pending', other: '{count} top-ups pending' },
    pendingCreditsDescription:
      'Pending credits are added after payment is verified. They are not included in the remaining balance.',
    managerViewerDescription: 'You can see your team’s usage and manage credit top-ups.',
    memberViewerDescription: 'You can see your usage and a summary of team usage.',
    creditOfferNames: { credits_usd_10: 'Small credit top-up', credits_usd_25: 'Medium credit top-up', credits_usd_50: 'Large credit top-up', credits_usd_100: 'Extra-large credit top-up' },
    oneTimeOfferDescription: 'One-time purchase. Automatic top-up stays off.',
    smallestOfferHint: 'Start with the smallest available top-up.',
  },
  de: {
    conversionDescription:
      '1.000 Credits entsprechen immer 1,00 US$. Die Nutzung wird genau erfasst, abgezogen werden jedoch nur ganze Credits.',
    balanceLabel: 'Verbleibende Credits',
    balanceDescription: 'Ihr Team nutzt dieses Guthaben gemeinsam über verbundene Dienste hinweg.',
    pendingCreditsLabel: { one: '{count} Aufladung ausstehend', other: '{count} Aufladungen ausstehend' },
    pendingCreditsDescription:
      'Ausstehende Credits werden nach bestätigter Zahlung gutgeschrieben. Sie sind nicht im verfügbaren Guthaben enthalten.',
    managerViewerDescription: 'Sie sehen die Nutzung Ihres Teams und können Credits aufladen.',
    memberViewerDescription: 'Sie sehen Ihre Nutzung und eine Zusammenfassung der Teamnutzung.',
    creditOfferNames: { credits_usd_10: 'Kleine Credit-Aufladung', credits_usd_25: 'Mittlere Credit-Aufladung', credits_usd_50: 'Große Credit-Aufladung', credits_usd_100: 'Sehr große Credit-Aufladung' },
    oneTimeOfferDescription: 'Einmaliger Kauf. Automatische Aufladungen bleiben ausgeschaltet.',
    smallestOfferHint: 'Beginnen Sie mit der kleinsten verfügbaren Aufladung.',
  },
  es: {
    conversionDescription:
      '1.000 créditos equivalen siempre a 1,00 US$. El uso se calcula con exactitud, pero solo se descuentan créditos enteros.',
    balanceLabel: 'Créditos restantes',
    balanceDescription: 'El equipo comparte este saldo entre los servicios conectados.',
    pendingCreditsLabel: { one: '{count} recarga pendiente', other: '{count} recargas pendientes' },
    pendingCreditsDescription:
      'Los créditos pendientes se añaden cuando se verifica el pago. No se incluyen en el saldo restante.',
    managerViewerDescription: 'Puedes ver el uso del equipo y gestionar las recargas de créditos.',
    memberViewerDescription: 'Puedes ver tu uso y un resumen del uso del equipo.',
    creditOfferNames: { credits_usd_10: 'Recarga pequeña de créditos', credits_usd_25: 'Recarga mediana de créditos', credits_usd_50: 'Recarga grande de créditos', credits_usd_100: 'Recarga extragrande de créditos' },
    oneTimeOfferDescription: 'Compra única. La recarga automática seguirá desactivada.',
    smallestOfferHint: 'Empieza con la recarga más pequeña disponible.',
  },
  fr: {
    conversionDescription:
      '1 000 crédits correspondent toujours à 1,00 $US. L’utilisation est calculée précisément, mais seuls les crédits entiers sont déduits.',
    balanceLabel: 'Crédits restants',
    balanceDescription: 'Votre équipe partage ce solde entre les services connectés.',
    pendingCreditsLabel: { one: '{count} recharge en attente', other: '{count} recharges en attente' },
    pendingCreditsDescription:
      'Les crédits en attente sont ajoutés après vérification du paiement. Ils ne sont pas inclus dans le solde restant.',
    managerViewerDescription: 'Vous pouvez consulter l’utilisation de l’équipe et gérer ses recharges de crédits.',
    memberViewerDescription: 'Vous pouvez consulter votre utilisation et un résumé de celle de l’équipe.',
    creditOfferNames: { credits_usd_10: 'Petite recharge de crédits', credits_usd_25: 'Recharge moyenne de crédits', credits_usd_50: 'Grande recharge de crédits', credits_usd_100: 'Très grande recharge de crédits' },
    oneTimeOfferDescription: 'Achat ponctuel. La recharge automatique reste désactivée.',
    smallestOfferHint: 'Commencez par la plus petite recharge disponible.',
  },
  it: {
    conversionDescription:
      '1.000 crediti equivalgono sempre a 1,00 USD. L’utilizzo è conteggiato con precisione, ma vengono detratti solo crediti interi.',
    balanceLabel: 'Crediti rimanenti',
    balanceDescription: 'Il team condivide questo saldo tra i servizi collegati.',
    pendingCreditsLabel: { one: '{count} ricarica in sospeso', other: '{count} ricariche in sospeso' },
    pendingCreditsDescription:
      'I crediti in sospeso vengono aggiunti dopo la verifica del pagamento. Non sono inclusi nel saldo rimanente.',
    managerViewerDescription: 'Puoi vedere l’utilizzo del team e gestire le ricariche di crediti.',
    memberViewerDescription: 'Puoi vedere il tuo utilizzo e un riepilogo dell’utilizzo del team.',
    creditOfferNames: { credits_usd_10: 'Ricarica piccola di crediti', credits_usd_25: 'Ricarica media di crediti', credits_usd_50: 'Ricarica grande di crediti', credits_usd_100: 'Ricarica extra grande di crediti' },
    oneTimeOfferDescription: 'Acquisto singolo. La ricarica automatica resta disattivata.',
    smallestOfferHint: 'Inizia dalla ricarica disponibile più piccola.',
  },
} satisfies Record<BillingCustomerLocale, BillingCreditCopy>;

export function billingCreditCopy(locale?: BillingCustomerLocale): BillingCreditCopy {
  return billingLocaleText(BILLING_CREDIT_COPY, locale);
}

export function billingPendingCreditsLabel(count: number, locale?: BillingCustomerLocale): string {
  return billingPluralCopy(billingCreditCopy(locale).pendingCreditsLabel, count, locale);
}

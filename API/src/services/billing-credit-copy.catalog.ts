import type {
  BillingCopyPluralForms,
  BillingCustomerLocale,
} from './billing-copy-locale.js';
import { billingLocale, billingLocaleText, billingPluralCopy } from './billing-copy-locale.js';

export type BillingCreditCopy = Readonly<{
  conversionDescription: string;
  balanceLabel: string;
  balanceDescription: string;
  organisationBalanceDescription: string;
  pendingSettlementDescription: string;
  pendingCreditsLabel: BillingCopyPluralForms;
  pendingCreditsDescription: string;
  managerViewerDescription: string;
  memberViewerDescription: string;
  teamName: string;
  teamMember: string;
  creditUnit: BillingCopyPluralForms;
  creditOfferNames: Readonly<Record<'credits_usd_10' | 'credits_usd_25' | 'credits_usd_50' | 'credits_usd_100', string>>;
  oneTimeOfferDescription: string;
  smallestOfferHint: string;
}>;

export const BILLING_CREDIT_COPY = {
  cs: {
    conversionDescription:
      '1 000 kreditů vždy odpovídá 1,00 USD. Spotřebu a zůstatek evidujeme s přesností na miliontinu kreditu.',
    balanceLabel: 'Zbývající kredity',
    balanceDescription: 'Tento zůstatek sdílí celý tým napříč připojenými službami.',
    organisationBalanceDescription: "Tento zůstatek sdílí týmy organizace napříč připojenými službami.",
    pendingSettlementDescription: "Potvrzený zůstatek je dostupný. Nedávnou spotřebu ještě zpracováváme a potvrzený součet ji zatím nezahrnuje.",
    pendingCreditsLabel: { one: 'Čeká {count} dobití', few: 'Čekají {count} dobití', other: 'Čeká {count} dobití' },
    pendingCreditsDescription:
      'Čekající kredity se přičtou až po ověření platby a nejsou součástí zbývajícího zůstatku.',
    managerViewerDescription: 'Zobrazí se vám využití celého týmu a můžete spravovat dobíjení.',
    memberViewerDescription: 'Zobrazí se vám vaše využití a souhrnné údaje o týmu.',
    teamName: 'Tým',
    teamMember: 'Člen týmu',
    creditUnit: { one: 'kredit', few: 'kredity', other: 'kreditů' },
    creditOfferNames: { credits_usd_10: 'Malé dobití kreditů', credits_usd_25: 'Střední dobití kreditů', credits_usd_50: 'Velké dobití kreditů', credits_usd_100: 'Největší dobití kreditů' },
    oneTimeOfferDescription: 'Jednorázové dobití. Nezapíná automatické dobíjení.',
    smallestOfferHint: 'Začněte nejmenším dostupným dobitím.',
  },
  'en-US': {
    conversionDescription:
      '1,000 credits always equal US$1.00. Usage and balances retain microcredit precision.',
    balanceLabel: 'Remaining credits',
    balanceDescription: 'Your team shares this balance across connected services.',
    organisationBalanceDescription: "This balance is shared across the organisation’s teams and connected services.",
    pendingSettlementDescription: "Your confirmed credit balance is available. Recent usage is still being reconciled and is not included in the confirmed usage total yet.",
    pendingCreditsLabel: { one: '{count} top-up pending', other: '{count} top-ups pending' },
    pendingCreditsDescription:
      'Pending credits are added after payment is verified. They are not included in the remaining balance.',
    managerViewerDescription: 'You can see your team’s usage and manage credit top-ups.',
    memberViewerDescription: 'You can see your usage and a summary of team usage.',
    teamName: 'Team',
    teamMember: 'Team member',
    creditUnit: { one: 'credit', other: 'credits' },
    creditOfferNames: { credits_usd_10: 'Small credit top-up', credits_usd_25: 'Medium credit top-up', credits_usd_50: 'Large credit top-up', credits_usd_100: 'Extra-large credit top-up' },
    oneTimeOfferDescription: 'One-time purchase. This does not enable automatic top-up.',
    smallestOfferHint: 'Start with the smallest available top-up.',
  },
  'en-GB': {
    conversionDescription:
      '1,000 credits always equal US$1.00. Usage and balances retain microcredit precision.',
    balanceLabel: 'Remaining credits',
    balanceDescription: 'Your team shares this balance across connected services.',
    organisationBalanceDescription: "This balance is shared across the organisation’s teams and connected services.",
    pendingSettlementDescription: "Your confirmed credit balance is available. Recent usage is still being reconciled and is not included in the confirmed usage total yet.",
    pendingCreditsLabel: { one: '{count} top-up pending', other: '{count} top-ups pending' },
    pendingCreditsDescription:
      'Pending credits are added after payment is verified. They are not included in the remaining balance.',
    managerViewerDescription: 'You can see your team’s usage and manage credit top-ups.',
    memberViewerDescription: 'You can see your usage and a summary of team usage.',
    teamName: 'Team',
    teamMember: 'Team member',
    creditUnit: { one: 'credit', other: 'credits' },
    creditOfferNames: { credits_usd_10: 'Small credit top-up', credits_usd_25: 'Medium credit top-up', credits_usd_50: 'Large credit top-up', credits_usd_100: 'Extra-large credit top-up' },
    oneTimeOfferDescription: 'One-time purchase. This does not enable automatic top-up.',
    smallestOfferHint: 'Start with the smallest available top-up.',
  },
  de: {
    conversionDescription:
      '1.000 Credits entsprechen immer 1,00 US$. Nutzung und Guthaben werden auf ein Millionstel Credit genau erfasst.',
    balanceLabel: 'Verbleibende Credits',
    balanceDescription: 'Ihr Team nutzt dieses Guthaben gemeinsam über verbundene Dienste hinweg.',
    organisationBalanceDescription: "Dieses Guthaben wird von den Teams der Organisation über verbundene Dienste hinweg geteilt.",
    pendingSettlementDescription: "Ihr bestätigtes Guthaben ist verfügbar. Neuere Nutzung wird noch abgeglichen und ist noch nicht in der bestätigten Summe enthalten.",
    pendingCreditsLabel: { one: '{count} Aufladung ausstehend', other: '{count} Aufladungen ausstehend' },
    pendingCreditsDescription:
      'Ausstehende Credits werden nach bestätigter Zahlung gutgeschrieben. Sie sind nicht im verfügbaren Guthaben enthalten.',
    managerViewerDescription: 'Sie sehen die Nutzung Ihres Teams und können Credits aufladen.',
    memberViewerDescription: 'Sie sehen Ihre Nutzung und eine Zusammenfassung der Teamnutzung.',
    teamName: 'Team',
    teamMember: 'Teammitglied',
    creditUnit: { one: 'Credit', other: 'Credits' },
    creditOfferNames: { credits_usd_10: 'Kleine Credit-Aufladung', credits_usd_25: 'Mittlere Credit-Aufladung', credits_usd_50: 'Große Credit-Aufladung', credits_usd_100: 'Sehr große Credit-Aufladung' },
    oneTimeOfferDescription: 'Einmaliger Kauf. Dadurch wird die automatische Aufladung nicht aktiviert.',
    smallestOfferHint: 'Beginnen Sie mit der kleinsten verfügbaren Aufladung.',
  },
  es: {
    conversionDescription:
      '1.000 créditos equivalen siempre a 1,00 US$. El uso y el saldo conservan una precisión de una millonésima de crédito.',
    balanceLabel: 'Créditos restantes',
    balanceDescription: 'El equipo comparte este saldo entre los servicios conectados.',
    organisationBalanceDescription: "Los equipos de la organización comparten este saldo entre los servicios conectados.",
    pendingSettlementDescription: "El saldo confirmado está disponible. El uso reciente aún se está conciliando y todavía no está incluido en el total confirmado.",
    pendingCreditsLabel: { one: '{count} recarga pendiente', other: '{count} recargas pendientes' },
    pendingCreditsDescription:
      'Los créditos pendientes se añaden cuando se verifica el pago. No se incluyen en el saldo restante.',
    managerViewerDescription: 'Puedes ver el uso del equipo y gestionar las recargas de créditos.',
    memberViewerDescription: 'Puedes ver tu uso y un resumen del uso del equipo.',
    teamName: 'Equipo',
    teamMember: 'Miembro del equipo',
    creditUnit: { one: 'crédito', other: 'créditos' },
    creditOfferNames: { credits_usd_10: 'Recarga pequeña de créditos', credits_usd_25: 'Recarga mediana de créditos', credits_usd_50: 'Recarga grande de créditos', credits_usd_100: 'Recarga extragrande de créditos' },
    oneTimeOfferDescription: 'Compra única. Esto no activa la recarga automática.',
    smallestOfferHint: 'Empieza con la recarga más pequeña disponible.',
  },
  fr: {
    conversionDescription:
      '1 000 crédits correspondent toujours à 1,00 $US. L’utilisation et le solde sont calculés au millionième de crédit près.',
    balanceLabel: 'Crédits restants',
    balanceDescription: 'Votre équipe partage ce solde entre les services connectés.',
    organisationBalanceDescription: "Les équipes de l’organisation partagent ce solde entre les services connectés.",
    pendingSettlementDescription: "Votre solde confirmé est disponible. L’utilisation récente est en cours de rapprochement et n’est pas encore incluse dans le total confirmé.",
    pendingCreditsLabel: { one: '{count} recharge en attente', other: '{count} recharges en attente' },
    pendingCreditsDescription:
      'Les crédits en attente sont ajoutés après vérification du paiement. Ils ne sont pas inclus dans le solde restant.',
    managerViewerDescription: 'Vous pouvez consulter l’utilisation de l’équipe et gérer ses recharges de crédits.',
    memberViewerDescription: 'Vous pouvez consulter votre utilisation et un résumé de celle de l’équipe.',
    teamName: 'Équipe',
    teamMember: 'Membre de l’équipe',
    creditUnit: { one: 'crédit', other: 'crédits' },
    creditOfferNames: { credits_usd_10: 'Petite recharge de crédits', credits_usd_25: 'Recharge moyenne de crédits', credits_usd_50: 'Grande recharge de crédits', credits_usd_100: 'Très grande recharge de crédits' },
    oneTimeOfferDescription: 'Achat ponctuel. Cela n’active pas la recharge automatique.',
    smallestOfferHint: 'Commencez par la plus petite recharge disponible.',
  },
  it: {
    conversionDescription:
      '1.000 crediti equivalgono sempre a 1,00 USD. Utilizzo e saldo mantengono una precisione al milionesimo di credito.',
    balanceLabel: 'Crediti rimanenti',
    balanceDescription: 'Il team condivide questo saldo tra i servizi collegati.',
    organisationBalanceDescription: "I team dell’organizzazione condividono questo saldo tra i servizi collegati.",
    pendingSettlementDescription: "Il saldo confermato è disponibile. L’utilizzo recente è ancora in fase di riconciliazione e non è incluso nel totale confermato.",
    pendingCreditsLabel: { one: '{count} ricarica in sospeso', other: '{count} ricariche in sospeso' },
    pendingCreditsDescription:
      'I crediti in sospeso vengono aggiunti dopo la verifica del pagamento. Non sono inclusi nel saldo rimanente.',
    managerViewerDescription: 'Puoi vedere l’utilizzo del team e gestire le ricariche di crediti.',
    memberViewerDescription: 'Puoi vedere il tuo utilizzo e un riepilogo dell’utilizzo del team.',
    teamName: 'Team',
    teamMember: 'Membro del team',
    creditUnit: { one: 'credito', other: 'crediti' },
    creditOfferNames: { credits_usd_10: 'Ricarica piccola di crediti', credits_usd_25: 'Ricarica media di crediti', credits_usd_50: 'Ricarica grande di crediti', credits_usd_100: 'Ricarica extra grande di crediti' },
    oneTimeOfferDescription: 'Acquisto singolo. Questo non attiva la ricarica automatica.',
    smallestOfferHint: 'Inizia dalla ricarica disponibile più piccola.',
  },
} satisfies Record<BillingCustomerLocale, BillingCreditCopy>;

export function billingCreditCopy(locale?: BillingCustomerLocale): BillingCreditCopy {
  return billingLocaleText(BILLING_CREDIT_COPY, locale);
}

export function billingPendingCreditsLabel(count: number, locale?: BillingCustomerLocale): string {
  return billingPluralCopy(billingCreditCopy(locale).pendingCreditsLabel, count, locale);
}

export function billingBuiltInCreditOfferCopy(key: string, locale?: BillingCustomerLocale) {
  const copy = billingCreditCopy(locale);
  if (!Object.prototype.hasOwnProperty.call(copy.creditOfferNames, key)) return null;
  const offerKey = key as keyof BillingCreditCopy['creditOfferNames'];
  return { name: copy.creditOfferNames[offerKey], description: copy.oneTimeOfferDescription };
}

export function billingLocalizedCreditDisplay(credits: string, locale?: BillingCustomerLocale): string {
  const copy = billingCreditCopy(locale);
  const [whole, fraction] = credits.split('.');
  const amount = BigInt(whole);
  const count = Math.abs(Number(credits));
  const formatter = new Intl.NumberFormat(billingLocale(locale));
  const sign = credits.startsWith('-') && amount === 0n ? '-' : '';
  const separator = formatter.formatToParts(1.1).find((part) => part.type === 'decimal')?.value;
  const formatted = `${sign}${formatter.format(amount)}${fraction ? `${separator}${fraction}` : ''}`;
  return `${formatted} ${billingPluralCopy(copy.creditUnit, count, locale)}`;
}

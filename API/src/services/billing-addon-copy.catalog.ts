import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocaleText, formatBillingCopy, type BillingLocaleCatalog } from './billing-copy-locale.js';

export type BillingAddonCopy = Readonly<{
  titleSuffix: string;
  catalogDescription: string;
  managerViewerDescription: string;
  memberViewerDescription: string;
  cancelTitle: string;
  cancelDescription: string;
  cancelsAtPeriodEnd: string;
  statusActive: string;
  statusCanceled: string;
  statusIncomplete: string;
  statusExpired: string;
  statusPastDue: string;
  statusTrialing: string;
  statusUnpaid: string;
  statusPaused: string;
  statusUnknown: string;
  confirmationScheduled: string;
  confirmationAlreadyScheduled: string;
  confirmationDescription: string;
  privacyOfferName: string;
  privacyOfferDescription: string;
  privacyBenefit: string;
  entitlementActive: string;
  entitlementActiveDescription: string;
  entitlementPending: string;
  entitlementPendingDescription: string;
  entitlementUnavailable: string;
  entitlementUnavailableDescription: string;
  entitlementInactive: string;
  entitlementInactiveDescription: string;
  noCollection: string;
  noEntitlementScope: string;
  checkoutUnavailable: string;
  cancelAction: string;
  cancelActionDescription: string;
  cancellationAlreadyScheduled: string;
  subscribeAction: string;
  subscribeActionDescription: string;
  checkoutAlreadyOpen: string;
}>;

export const BILLING_ADDON_COPY = {
  cs: {
    titleSuffix: 'doplňky',
    catalogDescription: 'Volitelná předplatná se účtují zvlášť od spotřeby kreditů.',
    managerViewerDescription: 'Můžete zobrazit stav přístupu a spravovat týmové doplňky.',
    memberViewerDescription: 'Zobrazí se váš přístup a souhrnný stav týmu.',
    cancelTitle: 'Zrušit doplněk {name}?',
    cancelDescription: 'Doplněk zůstane dostupný do konce aktuálního fakturačního období.',
    cancelsAtPeriodEnd: 'Skončí na konci období',
    statusActive: 'Aktivní',
    statusCanceled: 'Zrušeno',
    statusIncomplete: 'Čeká na platbu',
    statusExpired: 'Platba vypršela',
    statusPastDue: 'Platba po splatnosti',
    statusTrialing: 'Zkušební období',
    statusUnpaid: 'Nezaplaceno',
    statusPaused: 'Pozastaveno',
    statusUnknown: 'Stav není dostupný',
    confirmationScheduled: 'Zrušení je naplánováno',
    confirmationAlreadyScheduled: 'Zrušení už je naplánováno',
    confirmationDescription: 'Placený doplněk zůstane dostupný do konce aktuálního období.',
    privacyOfferName: 'Soukromí',
    privacyOfferDescription: 'Soukromý výzkum pro tento tým.',
    privacyBenefit: 'Soukromý výzkum pro tento tým.',
    entitlementActive: 'Přístup je aktivní',
    entitlementActiveDescription: 'Přístup k této nabídce je aktivní.',
    entitlementPending: 'Čeká na aktivaci',
    entitlementPendingDescription: 'Čekáme na ověření platby nebo aktivaci přístupu.',
    entitlementUnavailable: 'Není dostupné',
    entitlementUnavailableDescription: 'Tuto nabídku teď nelze aktivovat.',
    entitlementInactive: 'Přístup není aktivní',
    entitlementInactiveDescription: 'Přístup k této nabídce není aktivní.',
    noCollection: 'Platby nejsou zapnuté.',
    noEntitlementScope: 'Tuto nabídku teď nelze použít.',
    checkoutUnavailable: 'Platba není pro tuto nabídku nastavená.',
    cancelAction: 'Zrušit doplněk',
    cancelActionDescription: 'Naplánovat ukončení doplňku na konci aktuálního fakturačního období.',
    cancellationAlreadyScheduled: 'Zrušení už je naplánováno.',
    subscribeAction: 'Předplatit',
    subscribeActionDescription: 'Otevřít zabezpečenou platbu za tento měsíční doplněk.',
    checkoutAlreadyOpen: 'Platba za tuto nabídku už probíhá.',
  },
  'en-US': {
    titleSuffix: 'add-ons',
    catalogDescription: 'Optional subscriptions are billed separately from credit usage.',
    managerViewerDescription: 'You can see access status and manage team add-ons.',
    memberViewerDescription: 'You can see your access and a summary of team status.',
    cancelTitle: 'Cancel {name}?',
    cancelDescription: 'This add-on stays available until the current billing period ends.',
    cancelsAtPeriodEnd: 'Ends at period end',
    statusActive: 'Active',
    statusCanceled: 'Canceled',
    statusIncomplete: 'Awaiting payment',
    statusExpired: 'Payment expired',
    statusPastDue: 'Payment overdue',
    statusTrialing: 'Trial',
    statusUnpaid: 'Unpaid',
    statusPaused: 'Paused',
    statusUnknown: 'Status unavailable',
    confirmationScheduled: 'Cancellation scheduled',
    confirmationAlreadyScheduled: 'Cancellation already scheduled',
    confirmationDescription: 'This paid add-on stays available until the current billing period ends.',
    privacyOfferName: 'Privacy',
    privacyOfferDescription: 'Private research for this team.',
    privacyBenefit: 'Private research for this team.',
    entitlementActive: 'Access is active',
    entitlementActiveDescription: 'You can use this add-on.',
    entitlementPending: 'Waiting for activation',
    entitlementPendingDescription: 'Waiting for payment verification or access activation.',
    entitlementUnavailable: 'Unavailable',
    entitlementUnavailableDescription: 'This add-on can’t be activated right now.',
    entitlementInactive: 'Access is inactive',
    entitlementInactiveDescription: 'This add-on isn’t active.',
    noCollection: 'Payments are turned off.',
    noEntitlementScope: 'This add-on can’t be used right now.',
    checkoutUnavailable: 'Payment is not set up for this offer.',
    cancelAction: 'Cancel add-on',
    cancelActionDescription: 'Schedule the add-on to end with the current billing period.',
    cancellationAlreadyScheduled: 'Cancellation is already scheduled.',
    subscribeAction: 'Subscribe',
    subscribeActionDescription: 'Open the secure payment page for this monthly add-on.',
    checkoutAlreadyOpen: 'A payment for this offer is already in progress.',
  },
  'en-GB': {
    titleSuffix: 'add-ons',
    catalogDescription: 'Optional subscriptions are billed separately from credit usage.',
    managerViewerDescription: 'You can see access status and manage team add-ons.',
    memberViewerDescription: 'You can see your access and a summary of team status.',
    cancelTitle: 'Cancel {name}?',
    cancelDescription: 'This add-on stays available until the current billing period ends.',
    cancelsAtPeriodEnd: 'Ends at period end',
    statusActive: 'Active',
    statusCanceled: 'Cancelled',
    statusIncomplete: 'Awaiting payment',
    statusExpired: 'Payment expired',
    statusPastDue: 'Payment overdue',
    statusTrialing: 'Trial',
    statusUnpaid: 'Unpaid',
    statusPaused: 'Paused',
    statusUnknown: 'Status unavailable',
    confirmationScheduled: 'Cancellation scheduled',
    confirmationAlreadyScheduled: 'Cancellation already scheduled',
    confirmationDescription: 'This paid add-on stays available until the current billing period ends.',
    privacyOfferName: 'Privacy',
    privacyOfferDescription: 'Private research for this team.',
    privacyBenefit: 'Private research for this team.',
    entitlementActive: 'Access is active',
    entitlementActiveDescription: 'You can use this add-on.',
    entitlementPending: 'Waiting for activation',
    entitlementPendingDescription: 'Waiting for payment verification or access activation.',
    entitlementUnavailable: 'Unavailable',
    entitlementUnavailableDescription: 'This add-on can’t be activated right now.',
    entitlementInactive: 'Access is inactive',
    entitlementInactiveDescription: 'This add-on isn’t active.',
    noCollection: 'Payments are turned off.',
    noEntitlementScope: 'This add-on can’t be used right now.',
    checkoutUnavailable: 'Payment is not set up for this offer.',
    cancelAction: 'Cancel add-on',
    cancelActionDescription: 'Schedule the add-on to end with the current billing period.',
    cancellationAlreadyScheduled: 'Cancellation is already scheduled.',
    subscribeAction: 'Subscribe',
    subscribeActionDescription: 'Open the secure payment page for this monthly add-on.',
    checkoutAlreadyOpen: 'A payment for this offer is already in progress.',
  },
  de: {
    titleSuffix: 'Zusatzoptionen',
    catalogDescription: 'Optionale Abonnements werden getrennt von der Credit-Nutzung abgerechnet.',
    managerViewerDescription: 'Sie sehen den Zugriffsstatus und können Team-Zusatzoptionen verwalten.',
    memberViewerDescription: 'Sie sehen Ihren Zugriff und eine Zusammenfassung des Teamstatus.',
    cancelTitle: '{name} kündigen?',
    cancelDescription: 'Dieses Add-on bleibt bis zum Ende des aktuellen Abrechnungszeitraums verfügbar.',
    cancelsAtPeriodEnd: 'Endet am Ende des Zeitraums',
    statusActive: 'Aktiv',
    statusCanceled: 'Gekündigt',
    statusIncomplete: 'Zahlung ausstehend',
    statusExpired: 'Zahlung abgelaufen',
    statusPastDue: 'Zahlung überfällig',
    statusTrialing: 'Testphase',
    statusUnpaid: 'Unbezahlt',
    statusPaused: 'Pausiert',
    statusUnknown: 'Status nicht verfügbar',
    confirmationScheduled: 'Kündigung vorgemerkt',
    confirmationAlreadyScheduled: 'Kündigung ist bereits vorgemerkt',
    confirmationDescription: 'Dieses kostenpflichtige Add-on bleibt bis zum Ende des aktuellen Abrechnungszeitraums verfügbar.',
    privacyOfferName: 'Privatsphäre',
    privacyOfferDescription: 'Private Recherche für dieses Team.',
    privacyBenefit: 'Private Recherche für dieses Team.',
    entitlementActive: 'Zugriff ist aktiv',
    entitlementActiveDescription: 'Sie können diese Zusatzoption nutzen.',
    entitlementPending: 'Aktivierung ausstehend',
    entitlementPendingDescription: 'Die Zahlung oder Freischaltung wird noch bestätigt.',
    entitlementUnavailable: 'Nicht verfügbar',
    entitlementUnavailableDescription: 'Diese Zusatzoption kann derzeit nicht aktiviert werden.',
    entitlementInactive: 'Zugriff ist inaktiv',
    entitlementInactiveDescription: 'Diese Zusatzoption ist nicht aktiv.',
    noCollection: 'Zahlungen sind ausgeschaltet.',
    noEntitlementScope: 'Diese Zusatzoption kann derzeit nicht genutzt werden.',
    checkoutUnavailable: 'Die Zahlung ist für dieses Angebot nicht eingerichtet.',
    cancelAction: 'Add-on kündigen',
    cancelActionDescription: 'Das Add-on zum Ende des aktuellen Abrechnungszeitraums beenden.',
    cancellationAlreadyScheduled: 'Die Kündigung ist bereits vorgemerkt.',
    subscribeAction: 'Abonnieren',
    subscribeActionDescription: 'Öffnen Sie die sichere Zahlungsseite für diese monatliche Zusatzoption.',
    checkoutAlreadyOpen: 'Eine Zahlung für dieses Angebot läuft bereits.',
  },
  es: {
    titleSuffix: 'complementos',
    catalogDescription: 'Las suscripciones opcionales se cobran por separado del uso de créditos.',
    managerViewerDescription: 'Puedes ver el estado del acceso y gestionar los complementos del equipo.',
    memberViewerDescription: 'Puedes ver tu acceso y un resumen del estado del equipo.',
    cancelTitle: '¿Cancelar {name}?',
    cancelDescription: 'Este complemento seguirá disponible hasta que termine el periodo de facturación actual.',
    cancelsAtPeriodEnd: 'Finaliza al terminar el periodo',
    statusActive: 'Activo',
    statusCanceled: 'Cancelado',
    statusIncomplete: 'Pago pendiente',
    statusExpired: 'Pago caducado',
    statusPastDue: 'Pago atrasado',
    statusTrialing: 'Prueba',
    statusUnpaid: 'Sin pagar',
    statusPaused: 'En pausa',
    statusUnknown: 'Estado no disponible',
    confirmationScheduled: 'Cancelación programada',
    confirmationAlreadyScheduled: 'La cancelación ya está programada',
    confirmationDescription: 'Este complemento de pago seguirá disponible hasta que termine el periodo actual.',
    privacyOfferName: 'Privacidad',
    privacyOfferDescription: 'Investigación privada para este equipo.',
    privacyBenefit: 'Investigación privada para este equipo.',
    entitlementActive: 'Acceso activo',
    entitlementActiveDescription: 'Puedes usar este complemento.',
    entitlementPending: 'Pendiente de activación',
    entitlementPendingDescription: 'Estamos esperando a que se verifique el pago o se active el acceso.',
    entitlementUnavailable: 'No disponible',
    entitlementUnavailableDescription: 'Este complemento no se puede activar ahora.',
    entitlementInactive: 'Acceso inactivo',
    entitlementInactiveDescription: 'Este complemento no está activo.',
    noCollection: 'Los pagos están desactivados.',
    noEntitlementScope: 'Este complemento no se puede usar ahora.',
    checkoutUnavailable: 'El pago no está configurado para esta oferta.',
    cancelAction: 'Cancelar complemento',
    cancelActionDescription: 'Programar el fin del complemento al terminar el periodo actual.',
    cancellationAlreadyScheduled: 'La cancelación ya está programada.',
    subscribeAction: 'Suscribirse',
    subscribeActionDescription: 'Abrir el pago seguro de este complemento mensual.',
    checkoutAlreadyOpen: 'Ya hay una página de pago abierta.',
  },
  fr: {
    titleSuffix: 'options',
    catalogDescription: 'Les abonnements facultatifs sont facturés séparément de l’utilisation des crédits.',
    managerViewerDescription: 'Vous pouvez consulter l’accès et gérer les options de l’équipe.',
    memberViewerDescription: 'Vous pouvez consulter votre accès et un résumé de l’état de l’équipe.',
    cancelTitle: 'Résilier {name} ?',
    cancelDescription: 'Cette option reste disponible jusqu’à la fin de la période de facturation en cours.',
    cancelsAtPeriodEnd: 'Prend fin à la fin de la période',
    statusActive: 'Actif',
    statusCanceled: 'Résilié',
    statusIncomplete: 'Paiement en attente',
    statusExpired: 'Paiement expiré',
    statusPastDue: 'Paiement en retard',
    statusTrialing: 'Essai',
    statusUnpaid: 'Impayé',
    statusPaused: 'En pause',
    statusUnknown: 'Statut indisponible',
    confirmationScheduled: 'Résiliation programmée',
    confirmationAlreadyScheduled: 'Résiliation déjà programmée',
    confirmationDescription: 'Cette option payante reste disponible jusqu’à la fin de la période en cours.',
    privacyOfferName: 'Confidentialité',
    privacyOfferDescription: 'Recherche privée pour cette équipe.',
    privacyBenefit: 'Recherche privée pour cette équipe.',
    entitlementActive: 'Accès actif',
    entitlementActiveDescription: 'Vous pouvez utiliser cette option.',
    entitlementPending: 'Activation en attente',
    entitlementPendingDescription: 'La vérification du paiement ou l’activation de l’accès est en attente.',
    entitlementUnavailable: 'Indisponible',
    entitlementUnavailableDescription: 'Cette option ne peut pas être activée pour le moment.',
    entitlementInactive: 'Accès inactif',
    entitlementInactiveDescription: 'Cette option n’est pas active.',
    noCollection: 'Les paiements sont désactivés.',
    noEntitlementScope: 'Cette option ne peut pas être utilisée pour le moment.',
    checkoutUnavailable: 'Le paiement n’est pas configuré pour cette offre.',
    cancelAction: 'Résilier l’option',
    cancelActionDescription: 'Programmer la fin de l’option à la fin de la période de facturation en cours.',
    cancellationAlreadyScheduled: 'La résiliation est déjà programmée.',
    subscribeAction: 'S’abonner',
    subscribeActionDescription: 'Ouvrir le paiement sécurisé pour cette option mensuelle.',
    checkoutAlreadyOpen: 'Une page de paiement est déjà ouverte.',
  },
  it: {
    titleSuffix: 'componenti aggiuntivi',
    catalogDescription: 'Gli abbonamenti facoltativi sono addebitati separatamente dall’utilizzo dei crediti.',
    managerViewerDescription: 'Puoi vedere lo stato dell’accesso e gestire i componenti aggiuntivi del team.',
    memberViewerDescription: 'Puoi vedere il tuo accesso e un riepilogo dello stato del team.',
    cancelTitle: 'Annullare {name}?',
    cancelDescription: 'Questo componente aggiuntivo resta disponibile fino alla fine del periodo di fatturazione corrente.',
    cancelsAtPeriodEnd: 'Termina alla fine del periodo',
    statusActive: 'Attivo',
    statusCanceled: 'Annullato',
    statusIncomplete: 'Pagamento in attesa',
    statusExpired: 'Pagamento scaduto',
    statusPastDue: 'Pagamento in ritardo',
    statusTrialing: 'Prova',
    statusUnpaid: 'Non pagato',
    statusPaused: 'In pausa',
    statusUnknown: 'Stato non disponibile',
    confirmationScheduled: 'Annullamento programmato',
    confirmationAlreadyScheduled: 'Annullamento già programmato',
    confirmationDescription: 'Questo componente aggiuntivo a pagamento resta disponibile fino alla fine del periodo corrente.',
    privacyOfferName: 'Privacy',
    privacyOfferDescription: 'Ricerca privata per questo team.',
    privacyBenefit: 'Ricerca privata per questo team.',
    entitlementActive: 'Accesso attivo',
    entitlementActiveDescription: 'Puoi usare questa opzione.',
    entitlementPending: 'In attesa di attivazione',
    entitlementPendingDescription: 'In attesa della verifica del pagamento o dell’attivazione dell’accesso.',
    entitlementUnavailable: 'Non disponibile',
    entitlementUnavailableDescription: 'Questa opzione non può essere attivata al momento.',
    entitlementInactive: 'Accesso non attivo',
    entitlementInactiveDescription: 'Questa opzione non è attiva.',
    noCollection: 'I pagamenti sono disattivati.',
    noEntitlementScope: 'Questa opzione non può essere usata al momento.',
    checkoutUnavailable: 'Il pagamento non è configurato per questa offerta.',
    cancelAction: 'Annulla componente aggiuntivo',
    cancelActionDescription: 'Programma la fine del componente aggiuntivo alla fine del periodo corrente.',
    cancellationAlreadyScheduled: 'L’annullamento è già programmato.',
    subscribeAction: 'Abbonati',
    subscribeActionDescription: 'Apri il pagamento sicuro per questo componente aggiuntivo mensile.',
    checkoutAlreadyOpen: 'È già aperta una pagina di pagamento.',
  },
} satisfies BillingLocaleCatalog<BillingAddonCopy>;

export function billingAddonCopy(locale?: BillingCustomerLocale): BillingAddonCopy {
  return billingLocaleText(BILLING_ADDON_COPY, locale);
}

export function billingAddonCancelTitle(name: string, locale?: BillingCustomerLocale): string {
  return formatBillingCopy(billingAddonCopy(locale).cancelTitle, { name });
}

export function billingAddonSubscriptionStatus(
  status: string,
  locale?: BillingCustomerLocale,
): string {
  const copy = billingAddonCopy(locale);
  switch (status) {
    case 'active':
      return copy.statusActive;
    case 'canceled':
      return copy.statusCanceled;
    case 'incomplete':
      return copy.statusIncomplete;
    case 'incomplete_expired':
      return copy.statusExpired;
    case 'past_due':
      return copy.statusPastDue;
    case 'trialing':
      return copy.statusTrialing;
    case 'unpaid':
      return copy.statusUnpaid;
    case 'paused':
      return copy.statusPaused;
    default:
      return copy.statusUnknown;
  }
}

import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText } from './billing-copy-locale.js';

export type BillingCreditFundingCopy = Readonly<{
  title: string;
  description: string;
  paymentPending: string;
  offerUnavailable: string;
  topUpsDisabled: string;
  collectionUnavailable: string;
  continuePayment: string;
  continuePaymentDescription: string;
  buyOffer: string;
  buyOfferDescription: string;
  unavailableForPayment: string;
  buyOfferAtRate: string;
  liveRate: string;
  rateUnavailable: string;
}>;

export const BILLING_CREDIT_FUNDING_COPY = {
  cs: {
    title: 'Doplnit týmové kredity',
    description: 'Kredity platí používání propojených služeb. Předplatná se účtují zvlášť.',
    paymentPending: 'Platba už probíhá. Dokončete ji před dalším nákupem.',
    offerUnavailable: 'Tuto nabídku teď nelze použít.',
    topUpsDisabled: 'Dobíjení pro tuto službu není dostupné.',
    collectionUnavailable: 'Platby kartou teď nejsou dostupné.',
    continuePayment: 'Pokračovat v platbě',
    continuePaymentDescription: 'Pokračujte v platbě za tuto nabídku.',
    buyOffer: 'Koupit {credits}',
    buyOfferDescription: 'Zaplaťte jednorázové dobití. Nezapíná automatické dobíjení.',
    unavailableForPayment: 'Tuto nabídku teď nelze použít.',
    buyOfferAtRate: 'Koupit asi {credits}',
    liveRate: 'Podle dnešního kurzu 1 {currency} = {rate} USD. Počet kreditů se určí při zahájení platby.',
    rateUnavailable: 'Ceny kreditů v {currency} teď nejsou dostupné. Zkuste to prosím za chvíli.',
  },
  'en-US': {
    title: 'Add team credits',
    description: 'Credits pay for using connected services. Subscriptions are charged separately.',
    paymentPending: 'A payment is already in progress. Finish it before starting another purchase.',
    offerUnavailable: 'This offer is unavailable right now.',
    topUpsDisabled: 'Top-ups are unavailable for this service.',
    collectionUnavailable: 'Card payments are unavailable right now.',
    continuePayment: 'Continue payment',
    continuePaymentDescription: 'Continue your payment for this offer.',
    buyOffer: 'Buy {credits}',
    buyOfferDescription: 'Pay for a one-time top-up. This does not enable automatic top-up.',
    unavailableForPayment: 'This offer is unavailable right now.',
    buyOfferAtRate: 'Buy about {credits}',
    liveRate: 'At today\'s rate, 1 {currency} = {rate} USD. Your credits are fixed when you start the payment.',
    rateUnavailable: 'Credit prices in {currency} are unavailable right now. Please try again shortly.',
  },
  'en-GB': {
    title: 'Add team credits',
    description: 'Credits pay for using connected services. Subscriptions are charged separately.',
    paymentPending: 'A payment is already in progress. Finish it before starting another purchase.',
    offerUnavailable: 'This offer is unavailable right now.',
    topUpsDisabled: 'Top-ups are unavailable for this service.',
    collectionUnavailable: 'Card payments are unavailable right now.',
    continuePayment: 'Continue payment',
    continuePaymentDescription: 'Continue your payment for this offer.',
    buyOffer: 'Buy {credits}',
    buyOfferDescription: 'Pay for a one-time top-up. This does not enable automatic top-up.',
    unavailableForPayment: 'This offer is unavailable right now.',
    buyOfferAtRate: 'Buy about {credits}',
    liveRate: 'At today\'s rate, 1 {currency} = {rate} USD. Your credits are fixed when you start the payment.',
    rateUnavailable: 'Credit prices in {currency} are unavailable right now. Please try again shortly.',
  },
  de: {
    title: 'Team-Credits aufladen',
    description: 'Credits bezahlen die Nutzung verbundener Dienste. Abonnements werden separat abgerechnet.',
    paymentPending: 'Eine Zahlung läuft bereits. Schließen Sie sie ab, bevor Sie einen weiteren Kauf starten.',
    offerUnavailable: 'Dieses Angebot ist derzeit nicht verfügbar.',
    topUpsDisabled: 'Aufladungen sind für diesen Dienst nicht verfügbar.',
    collectionUnavailable: 'Kartenzahlungen sind derzeit nicht verfügbar.',
    continuePayment: 'Zahlung fortsetzen',
    continuePaymentDescription: 'Setzen Sie die Zahlung für dieses Angebot fort.',
    buyOffer: '{credits} kaufen',
    buyOfferDescription: 'Für eine einmalige Aufladung bezahlen. Dadurch wird die automatische Aufladung nicht aktiviert.',
    unavailableForPayment: 'Dieses Angebot ist derzeit nicht verfügbar.',
    buyOfferAtRate: 'Etwa {credits} kaufen',
    liveRate: 'Zum heutigen Kurs: 1 {currency} = {rate} USD. Ihre Credits werden beim Start der Zahlung festgelegt.',
    rateUnavailable: 'Credit-Preise in {currency} sind derzeit nicht verfügbar. Bitte versuchen Sie es gleich noch einmal.',
  },
  es: {
    title: 'Añadir créditos al equipo',
    description: 'Los créditos pagan el uso de los servicios conectados. Las suscripciones se cobran aparte.',
    paymentPending: 'Ya hay un pago en curso. Termínalo antes de iniciar otra compra.',
    offerUnavailable: 'Esta oferta no está disponible ahora.',
    topUpsDisabled: 'Las recargas no están disponibles para este servicio.',
    collectionUnavailable: 'Los pagos con tarjeta no están disponibles ahora.',
    continuePayment: 'Continuar con el pago',
    continuePaymentDescription: 'Continúa el pago de esta oferta.',
    buyOffer: 'Comprar {credits}',
    buyOfferDescription: 'Paga una recarga única. Esto no activa la recarga automática.',
    unavailableForPayment: 'Esta oferta no está disponible ahora.',
    buyOfferAtRate: 'Comprar unos {credits}',
    liveRate: 'Al cambio de hoy, 1 {currency} = {rate} USD. Tus créditos se fijan al iniciar el pago.',
    rateUnavailable: 'Los precios de los créditos en {currency} no están disponibles ahora. Inténtalo de nuevo en unos minutos.',
  },
  fr: {
    title: 'Ajouter des crédits à l’équipe',
    description: 'Les crédits paient l’utilisation des services connectés. Les abonnements sont facturés séparément.',
    paymentPending: 'Un paiement est déjà en cours. Terminez-le avant de lancer un autre achat.',
    offerUnavailable: 'Cette offre est indisponible pour le moment.',
    topUpsDisabled: 'Les recharges ne sont pas disponibles pour ce service.',
    collectionUnavailable: 'Les paiements par carte sont indisponibles pour le moment.',
    continuePayment: 'Continuer le paiement',
    continuePaymentDescription: 'Continuez le paiement de cette offre.',
    buyOffer: 'Acheter {credits}',
    buyOfferDescription: 'Payez une recharge ponctuelle. Cela n’active pas la recharge automatique.',
    unavailableForPayment: 'Cette offre est indisponible pour le moment.',
    buyOfferAtRate: 'Acheter environ {credits}',
    liveRate: 'Au taux du jour, 1 {currency} = {rate} USD. Vos crédits sont fixés au début du paiement.',
    rateUnavailable: 'Les prix des crédits en {currency} sont indisponibles pour le moment. Réessayez dans quelques instants.',
  },
  it: {
    title: 'Aggiungi crediti al team',
    description: 'I crediti pagano l’utilizzo dei servizi collegati. Gli abbonamenti vengono addebitati a parte.',
    paymentPending: 'È già in corso un pagamento. Completalo prima di iniziare un altro acquisto.',
    offerUnavailable: 'Questa offerta non è disponibile al momento.',
    topUpsDisabled: 'Le ricariche non sono disponibili per questo servizio.',
    collectionUnavailable: 'I pagamenti con carta non sono disponibili al momento.',
    continuePayment: 'Continua il pagamento',
    continuePaymentDescription: 'Continua il pagamento per questa offerta.',
    buyOffer: 'Acquista {credits}',
    buyOfferDescription: 'Paga una ricarica singola. Questo non attiva la ricarica automatica.',
    unavailableForPayment: 'Questa offerta non è disponibile al momento.',
    buyOfferAtRate: 'Acquista circa {credits}',
    liveRate: 'Al cambio di oggi, 1 {currency} = {rate} USD. I crediti vengono fissati quando inizi il pagamento.',
    rateUnavailable: 'I prezzi dei crediti in {currency} non sono disponibili al momento. Riprova tra poco.',
  },
} satisfies BillingLocaleCatalog<BillingCreditFundingCopy>;

export function billingCreditFundingCopy(locale?: BillingCustomerLocale): BillingCreditFundingCopy {
  return billingLocaleText(BILLING_CREDIT_FUNDING_COPY, locale);
}

import { billingLocale, type BillingCustomerLocale } from './billing-copy-locale.js';

type Copy = { confirmed:string; pending:string; unavailable:string; balance:string; balancePending:string };
const copy:Record<BillingCustomerLocale,Copy> = {
  'en-US': {confirmed:'Up to date.',pending:'This bill is awaiting reconciliation. No amount is confirmed yet.',
    unavailable:'This section is temporarily unavailable. Try again.',balance:'Confirmed organisation credits.',
    balancePending:'The credit balance is confirmed. Usage settlement is awaiting reconciliation.'},
  'en-GB': {confirmed:'Up to date.',pending:'This bill is awaiting reconciliation. No amount is confirmed yet.',
    unavailable:'This section is temporarily unavailable. Try again.',balance:'Confirmed organisation credits.',
    balancePending:'The credit balance is confirmed. Usage settlement is awaiting reconciliation.'},
  cs:{confirmed:'Aktuální údaje.',pending:'Vyúčtování čeká na odsouhlasení. Částka zatím není potvrzena.',
    unavailable:'Tato část je dočasně nedostupná. Zkuste to znovu.',balance:'Potvrzené kredity organizace.',
    balancePending:'Zůstatek kreditů je potvrzen. Zaúčtování spotřeby čeká na odsouhlasení.'},
  de:{confirmed:'Aktuell.',pending:'Diese Abrechnung wartet auf Abstimmung. Noch ist kein Betrag bestätigt.',
    unavailable:'Dieser Bereich ist vorübergehend nicht verfügbar. Versuchen Sie es erneut.',balance:'Bestätigte Guthaben der Organisation.',
    balancePending:'Das Guthaben ist bestätigt. Die Verbrauchsabrechnung wartet auf Abstimmung.'},
  es:{confirmed:'Datos actualizados.',pending:'Esta factura está pendiente de conciliación. Aún no hay un importe confirmado.',
    unavailable:'Esta sección no está disponible temporalmente. Inténtelo de nuevo.',balance:'Créditos confirmados de la organización.',
    balancePending:'El saldo está confirmado. La liquidación del consumo está pendiente de conciliación.'},
  fr:{confirmed:'À jour.',pending:'Cette facture attend un rapprochement. Aucun montant n’est encore confirmé.',
    unavailable:'Cette section est temporairement indisponible. Réessayez.',balance:'Crédits confirmés de l’organisation.',
    balancePending:'Le solde est confirmé. Le règlement de la consommation attend un rapprochement.'},
  it:{confirmed:'Aggiornato.',pending:'Questa fattura è in attesa di riconciliazione. Nessun importo è ancora confermato.',
    unavailable:'Questa sezione è temporaneamente non disponibile. Riprova.',balance:'Crediti confermati dell’organizzazione.',
    balancePending:'Il saldo è confermato. Il consumo è in attesa di riconciliazione.'},
};
const extra:Record<BillingCustomerLocale,{regionRequired:string;retained:string}>={
  'en-US':{regionRequired:'Choose the organisation billing region to continue.',retained:'Historical team credits and consents are retained separately. They are excluded from this organisation wallet and await reconciliation.'},
  'en-GB':{regionRequired:'Choose the organisation billing region to continue.',retained:'Historical team credits and consents are retained separately. They are excluded from this organisation wallet and await reconciliation.'},
  cs:{regionRequired:'Pro pokračování vyberte fakturační oblast organizace.',retained:'Historické týmové kredity a souhlasy zůstávají oddělené. Nejsou zahrnuty v peněžence organizace a čekají na odsouhlasení.'},
  de:{regionRequired:'Wählen Sie die Abrechnungsregion der Organisation, um fortzufahren.',retained:'Historische Teamguthaben und Einwilligungen bleiben getrennt erhalten. Sie sind nicht in diesem Organisationsguthaben enthalten und warten auf Abstimmung.'},
  es:{regionRequired:'Elija la región de facturación de la organización para continuar.',retained:'Los créditos y consentimientos históricos de los equipos se conservan por separado. No están incluidos en este saldo de la organización y esperan conciliación.'},
  fr:{regionRequired:'Choisissez la région de facturation de l’organisation pour continuer.',retained:'Les crédits et consentements historiques des équipes restent séparés. Ils sont exclus de ce portefeuille de l’organisation et attendent un rapprochement.'},
  it:{regionRequired:'Scegli la regione di fatturazione dell’organizzazione per continuare.',retained:'I crediti e i consensi storici dei team restano separati. Sono esclusi da questo portafoglio dell’organizzazione e attendono riconciliazione.'},
};
export const billingOrganisationCopy=(locale?:BillingCustomerLocale)=>({...copy[billingLocale(locale)],...extra[billingLocale(locale)]});

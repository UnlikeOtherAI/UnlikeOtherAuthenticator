import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocaleText,type BillingLocaleCatalog } from './billing-copy-locale.js';
const en={offersUnavailable:'Top-up offers are temporarily unavailable. Your saved automatic top-up settings are shown below.',
  savedCurrency:'Automatic top-up totals use the saved consent currency. Other funding remains in payment history.'};
const copy={
  'en-US':en,'en-GB':en,
  cs:{offersUnavailable:'Nabídky dobití jsou dočasně nedostupné. Níže jsou uložená nastavení automatického dobíjení.',savedCurrency:'Částky automatického dobíjení jsou v měně uloženého souhlasu. Ostatní platby zůstávají v historii plateb.'},
  de:{offersUnavailable:'Aufladeangebote sind vorübergehend nicht verfügbar. Unten sehen Sie Ihre gespeicherten Einstellungen für automatisches Aufladen.',savedCurrency:'Summen für automatisches Aufladen verwenden die Währung der gespeicherten Einwilligung. Andere Zahlungen bleiben im Zahlungsverlauf.'},
  es:{offersUnavailable:'Las ofertas de recarga no están disponibles temporalmente. A continuación se muestra la configuración guardada de recarga automática.',savedCurrency:'Los totales de recarga automática usan la moneda del consentimiento guardado. Las demás recargas permanecen en el historial de pagos.'},
  fr:{offersUnavailable:'Les offres de recharge sont temporairement indisponibles. Les paramètres enregistrés de recharge automatique figurent ci-dessous.',savedCurrency:'Les totaux de recharge automatique utilisent la devise du consentement enregistré. Les autres recharges restent dans l’historique des paiements.'},
  it:{offersUnavailable:'Le offerte di ricarica sono temporaneamente indisponibili. Di seguito sono riportate le impostazioni salvate della ricarica automatica.',savedCurrency:'I totali della ricarica automatica usano la valuta del consenso salvato. Le altre ricariche restano nella cronologia dei pagamenti.'},
} satisfies BillingLocaleCatalog<typeof en>;
export const organisationFundingCopy=(locale?:BillingCustomerLocale)=>billingLocaleText(copy,locale);

import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText, formatBillingCopy } from './billing-copy-locale.js';

type BillingStatementCopy = Readonly<{
  portfolioTitle: string;
  portfolioDescription: string;
  teamUsageTitle: string;
  noUsage: string;
  recordedUsage: string;
  otherServiceUsage: string;
  unattributedOrigin: string;
  unattributedUsage: string;
  share: string;
  callsShareLabel: string;
  usageShareLabel: string;
  usageShareSummary: string;
  rawTeamUsage: string;
  rawProviderCost: string;
  usageContribution: string;
  providerCostShare: string;
  providerCostContribution: string;
  providerCostContributionUnavailable: string;
  billableUsage: string;
  meteredUsage: string;
  freeUsageDetails: string;
  providerCostDetails: string;
  usageUnits: Readonly<Record<string, string>>;
}>;

const catalog: BillingLocaleCatalog<BillingStatementCopy> = {
  cs: {
    portfolioTitle: 'Využití připojených služeb',
    portfolioDescription: 'Týmová spotřeba napříč připojenými službami. Ostatní služby jsou uvedené pro přehled a nezvyšují částku této fakturace.',
    teamUsageTitle: 'Využití týmu: {name}',
    noUsage: 'V tomto období nebyla zaznamenána měřená spotřeba týmu.',
    recordedUsage: 'Tým využil {usage}. Služba {product} představovala {contribution}.',
    otherServiceUsage: 'Spotřeba ostatních služeb je pouze informativní a nemění částku této fakturace.',
    unattributedOrigin: 'Neurčený původ',
    unattributedUsage: 'Nepřiřazená spotřeba',
    share: '{percent} % {label}',
    callsShareLabel: 'volání služby {name}',
    usageShareLabel: 'spotřeby {unit}',
    usageShareSummary: '{percent} % spotřeby {unit}',
    rawTeamUsage: '{count} použitých {unit} za celý tým',
    rawProviderCost: 'Náklady poskytovatele za celý tým: {amount}',
    usageContribution: '{name}: {count} použitých {unit} ({percent} %)',
    providerCostShare: '{percent} % z nákladů služby {service} v {currency}',
    providerCostContribution: '{name}: {percent} % z nákladů poskytovatele ({amount})',
    providerCostContributionUnavailable: '{name}: náklady poskytovatele ve výši {amount}; podíl po opravách nelze určit',
    billableUsage: '{billable} účtovaných {unit} ({raw} použitých)',
    meteredUsage: 'Spotřeba podle využití',
    freeUsageDetails: 'Hodnota spotřeby: {cost}; bezplatný tarif',
    providerCostDetails: 'Náklady poskytovatele: {cost} + přirážka {percent} % ({markup})',
    usageUnits: { tokens: 'tokenů', requests: 'požadavků', test_runs: 'testovacích běhů' },
  },
  'en-US': {
    portfolioTitle: 'Connected-service usage',
    portfolioDescription: 'Team-wide usage across connected services. Other services are shown for context and are not added to this statement total.',
    teamUsageTitle: '{name} team usage',
    noUsage: 'There was no metered team usage in this period.',
    recordedUsage: 'The team used {usage}. {product} accounted for {contribution}.',
    otherServiceUsage: 'Usage from other services is informational and does not change this statement total.',
    unattributedOrigin: 'Unattributed origin',
    unattributedUsage: 'Unattributed usage',
    share: '{percent}% of {label}',
    callsShareLabel: '{name} calls',
    usageShareLabel: '{unit} usage',
    usageShareSummary: '{percent}% of {unit}',
    rawTeamUsage: '{count} raw {unit} across this team',
    rawProviderCost: '{amount} raw provider cost across this team',
    usageContribution: '{name} used {count} raw {unit} ({percent}%)',
    providerCostShare: '{percent}% of {service} {currency} provider cost',
    providerCostContribution: '{name} used {amount} raw provider cost ({percent}%)',
    providerCostContributionUnavailable: '{name} used {amount} raw provider cost; share unavailable after corrections',
    billableUsage: '{billable} billable {unit} ({raw} raw)',
    meteredUsage: 'Metered usage',
    freeUsageDetails: 'Usage value {cost}; free tariff',
    providerCostDetails: 'Provider cost {cost} + {percent}% ({markup})',
    usageUnits: { tokens: 'tokens', requests: 'requests', test_runs: 'test runs' },
  },
  'en-GB': {
    portfolioTitle: 'Connected-service usage',
    portfolioDescription: 'Team-wide usage across connected services. Other services are shown for context and are not added to this statement total.',
    teamUsageTitle: '{name} team usage',
    noUsage: 'There was no metered team usage in this period.',
    recordedUsage: 'The team used {usage}. {product} accounted for {contribution}.',
    otherServiceUsage: 'Usage from other services is informational and does not change this statement total.',
    unattributedOrigin: 'Unattributed origin',
    unattributedUsage: 'Unattributed usage',
    share: '{percent}% of {label}',
    callsShareLabel: '{name} calls',
    usageShareLabel: '{unit} usage',
    usageShareSummary: '{percent}% of {unit}',
    rawTeamUsage: '{count} raw {unit} across this team',
    rawProviderCost: '{amount} raw provider cost across this team',
    usageContribution: '{name} used {count} raw {unit} ({percent}%)',
    providerCostShare: '{percent}% of {service} {currency} provider cost',
    providerCostContribution: '{name} used {amount} raw provider cost ({percent}%)',
    providerCostContributionUnavailable: '{name} used {amount} raw provider cost; share unavailable after corrections',
    billableUsage: '{billable} billable {unit} ({raw} raw)',
    meteredUsage: 'Metered usage',
    freeUsageDetails: 'Usage value {cost}; free tariff',
    providerCostDetails: 'Provider cost {cost} + {percent}% ({markup})',
    usageUnits: { tokens: 'tokens', requests: 'requests', test_runs: 'test runs' },
  },
  de: {
    portfolioTitle: 'Nutzung verbundener Dienste',
    portfolioDescription: 'Teamweite Nutzung verbundener Dienste. Andere Dienste dienen der Übersicht und werden nicht zur Summe dieser Abrechnung addiert.',
    teamUsageTitle: 'Teamnutzung: {name}',
    noUsage: 'In diesem Zeitraum wurde keine gemessene Teamnutzung erfasst.',
    recordedUsage: 'Das Team nutzte {usage}. {product} entfiel auf {contribution}.',
    otherServiceUsage: 'Die Nutzung anderer Dienste dient nur zur Information und ändert diese Abrechnungssumme nicht.',
    unattributedOrigin: 'Nicht zugeordnete Herkunft',
    unattributedUsage: 'Nicht zugeordnete Nutzung',
    share: '{percent} % von {label}',
    callsShareLabel: 'Aufrufe von {name}',
    usageShareLabel: 'Nutzung von {unit}',
    usageShareSummary: '{percent} % der Nutzung von {unit}',
    rawTeamUsage: '{count} Rohwerte für {unit} im ganzen Team',
    rawProviderCost: '{amount} Rohkosten des Anbieters im ganzen Team',
    usageContribution: '{name} nutzte {count} Rohwerte für {unit} ({percent} %)',
    providerCostShare: '{percent} % der {currency}-Anbieterkosten von {service}',
    providerCostContribution: '{name} verursachte {amount} Rohkosten beim Anbieter ({percent} %)',
    providerCostContributionUnavailable: '{name} verursachte {amount} Rohkosten beim Anbieter; Anteil nach Korrekturen nicht verfügbar',
    billableUsage: '{billable} abrechenbare {unit} ({raw} Rohwerte)',
    meteredUsage: 'Gemessene Nutzung',
    freeUsageDetails: 'Nutzungswert {cost}; kostenloser Tarif',
    providerCostDetails: 'Anbieterkosten {cost} + Aufschlag {percent} % ({markup})',
    usageUnits: { tokens: 'Tokens', requests: 'Anfragen', test_runs: 'Testläufe' },
  },
  es: {
    portfolioTitle: 'Uso de servicios conectados',
    portfolioDescription: 'Uso de todo el equipo en los servicios conectados. Los demás servicios se muestran como referencia y no se suman al total de este estado.',
    teamUsageTitle: 'Uso del equipo: {name}',
    noUsage: 'El equipo no tuvo consumo medido durante este periodo.',
    recordedUsage: 'El equipo usó {usage}. {product} representó {contribution}.',
    otherServiceUsage: 'El uso de otros servicios es informativo y no modifica el total de este estado.',
    unattributedOrigin: 'Origen sin atribuir',
    unattributedUsage: 'Uso sin atribuir',
    share: '{percent} % de {label}',
    callsShareLabel: 'llamadas de {name}',
    usageShareLabel: 'uso de {unit}',
    usageShareSummary: '{percent} % del uso de {unit}',
    rawTeamUsage: '{count} unidades sin procesar de {unit} en todo el equipo',
    rawProviderCost: '{amount} de coste bruto del proveedor en todo el equipo',
    usageContribution: '{name} usó {count} unidades sin procesar de {unit} ({percent} %)',
    providerCostShare: '{percent} % del coste del proveedor de {service} en {currency}',
    providerCostContribution: '{name} usó {amount} de coste bruto del proveedor ({percent} %)',
    providerCostContributionUnavailable: '{name} usó {amount} de coste bruto del proveedor; no se puede determinar la proporción tras los ajustes',
    billableUsage: '{billable} {unit} facturables ({raw} sin procesar)',
    meteredUsage: 'Consumo medido',
    freeUsageDetails: 'Valor del consumo: {cost}; tarifa gratuita',
    providerCostDetails: 'Coste del proveedor {cost} + margen {percent} % ({markup})',
    usageUnits: { tokens: 'tokens', requests: 'solicitudes', test_runs: 'pruebas' },
  },
  fr: {
    portfolioTitle: 'Utilisation des services connectés',
    portfolioDescription: 'Utilisation de toute l’équipe dans les services connectés. Les autres services sont indiqués à titre informatif et ne sont pas ajoutés au total de ce relevé.',
    teamUsageTitle: 'Utilisation de l’équipe : {name}',
    noUsage: 'Aucune utilisation mesurée de l’équipe pendant cette période.',
    recordedUsage: 'L’équipe a utilisé {usage}. {product} représente {contribution}.',
    otherServiceUsage: 'L’utilisation des autres services est informative et ne modifie pas le total de ce relevé.',
    unattributedOrigin: 'Origine non attribuée',
    unattributedUsage: 'Utilisation non attribuée',
    share: '{percent} % de {label}',
    callsShareLabel: 'appels de {name}',
    usageShareLabel: 'utilisation de {unit}',
    usageShareSummary: '{percent} % de l’utilisation de {unit}',
    rawTeamUsage: '{count} unités brutes de {unit} pour toute l’équipe',
    rawProviderCost: '{amount} de coût fournisseur brut pour toute l’équipe',
    usageContribution: '{name} a utilisé {count} unités brutes de {unit} ({percent} %)',
    providerCostShare: '{percent} % du coût fournisseur {currency} de {service}',
    providerCostContribution: '{name} a utilisé {amount} de coût fournisseur brut ({percent} %)',
    providerCostContributionUnavailable: '{name} a utilisé {amount} de coût fournisseur brut ; part indisponible après corrections',
    billableUsage: '{billable} {unit} facturables ({raw} brutes)',
    meteredUsage: 'Utilisation mesurée',
    freeUsageDetails: 'Valeur de l’utilisation : {cost} ; forfait gratuit',
    providerCostDetails: 'Coût fournisseur {cost} + majoration {percent} % ({markup})',
    usageUnits: { tokens: 'jetons', requests: 'requêtes', test_runs: 'tests' },
  },
  it: {
    portfolioTitle: 'Utilizzo dei servizi collegati',
    portfolioDescription: 'Utilizzo dell’intero team nei servizi collegati. Gli altri servizi sono mostrati per riferimento e non vengono aggiunti al totale di questo estratto.',
    teamUsageTitle: 'Utilizzo del team: {name}',
    noUsage: 'In questo periodo non è stato registrato un utilizzo misurato del team.',
    recordedUsage: 'Il team ha usato {usage}. {product} ha rappresentato {contribution}.',
    otherServiceUsage: 'L’utilizzo degli altri servizi è informativo e non modifica il totale di questo estratto.',
    unattributedOrigin: 'Origine non attribuita',
    unattributedUsage: 'Utilizzo non attribuito',
    share: '{percent} % di {label}',
    callsShareLabel: 'chiamate di {name}',
    usageShareLabel: 'utilizzo di {unit}',
    usageShareSummary: '{percent} % dell’utilizzo di {unit}',
    rawTeamUsage: '{count} unità grezze di {unit} per tutto il team',
    rawProviderCost: '{amount} di costi grezzi del fornitore per tutto il team',
    usageContribution: '{name} ha usato {count} unità grezze di {unit} ({percent} %)',
    providerCostShare: '{percent} % dei costi del fornitore {currency} di {service}',
    providerCostContribution: '{name} ha usato {amount} di costi grezzi del fornitore ({percent} %)',
    providerCostContributionUnavailable: '{name} ha usato {amount} di costi grezzi del fornitore; quota non disponibile dopo le rettifiche',
    billableUsage: '{billable} {unit} fatturabili ({raw} grezzi)',
    meteredUsage: 'Utilizzo misurato',
    freeUsageDetails: 'Valore dell’utilizzo: {cost}; piano gratuito',
    providerCostDetails: 'Costi del fornitore {cost} + maggiorazione {percent} % ({markup})',
    usageUnits: { tokens: 'token', requests: 'richieste', test_runs: 'test' },
  },
};

export const billingStatementCopy = (locale?: BillingCustomerLocale): BillingStatementCopy =>
  billingLocaleText(catalog, locale);

export const billingStatementText = (
  template: string,
  values: Readonly<Record<string, string | number>> = {},
): string => formatBillingCopy(template, values);

export const billingStatementUsageUnit = (
  unit: string,
  locale?: BillingCustomerLocale,
): string => billingStatementCopy(locale).usageUnits[unit] ?? unit;

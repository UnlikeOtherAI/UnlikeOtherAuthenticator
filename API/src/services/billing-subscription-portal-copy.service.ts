import type { PrismaClient } from '@prisma/client';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingLocaleText,formatBillingCopy } from './billing-copy-locale.js';
import { AppError } from '../utils/errors.js';

const copy={
  cs:{label:'Spravovat předplatné {product} ({currency})',description:'Otevře platební nastavení zákazníka tohoto předplatného v {currency}. Mohou se zobrazit i další předplatná téhož zákazníka. Automatické dobíjení kreditů spravujte v jeho vlastních ovládacích prvcích.'},
  'en-US':{label:'Manage {product} subscription ({currency})',description:'Opens payment settings for this subscription’s {currency} customer. Other subscriptions on that customer may also appear. Manage automatic credit funding in its own controls.'},
  'en-GB':{label:'Manage {product} subscription ({currency})',description:'Opens payment settings for this subscription’s {currency} customer. Other subscriptions on that customer may also appear. Manage automatic credit funding in its own controls.'},
  de:{label:'{product}-Abonnement verwalten ({currency})',description:'Öffnet die Zahlungseinstellungen des Kunden dieses Abonnements in {currency}. Weitere Abonnements desselben Kunden können ebenfalls erscheinen. Automatische Credit-Aufladungen verwalten Sie in den eigenen Steuerelementen.'},
  es:{label:'Gestionar suscripción de {product} ({currency})',description:'Abre los ajustes de pago del cliente de esta suscripción en {currency}. También pueden aparecer otras suscripciones del mismo cliente. Gestiona la recarga automática de créditos en sus propios controles.'},
  fr:{label:'Gérer l’abonnement {product} ({currency})',description:'Ouvre les paramètres de paiement du client de cet abonnement en {currency}. D’autres abonnements du même client peuvent aussi apparaître. Gérez les recharges automatiques de crédits dans leurs propres commandes.'},
  it:{label:'Gestisci abbonamento {product} ({currency})',description:'Apre le impostazioni di pagamento del cliente di questo abbonamento in {currency}. Possono apparire anche altri abbonamenti dello stesso cliente. Gestisci la ricarica automatica dei crediti nei relativi controlli.'},
};

/** Name the captured subscription currency, which can differ from today's
 * assigned tariff. This portal never claims to manage the funding customer. */
export async function subscriptionPortalCopy(input:{subscriptionId:string;organisationId:string;serviceId:string;
  locale?:BillingCustomerLocale},prisma:PrismaClient) {
  const row=await prisma.billingStripeSubscription.findFirst({where:{id:input.subscriptionId,orgId:input.organisationId,
    serviceId:input.serviceId},include:{tariff:{select:{currency:true}},service:{select:{name:true}},customer:true}});
  if(!row||row.scope!=='ORGANISATION'||row.customer.scope!=='ORGANISATION'||row.customer.teamId!==null||
    row.customer.accountId!==row.accountId||row.customer.orgId!==row.orgId||!row.customer.stripeCustomerId)
    throw new AppError('SERVICE_UNAVAILABLE',503,'STRIPE_SUBSCRIPTION_PORTAL_BINDING_UNPROVEN');
  const text=billingLocaleText(copy,input.locale),values={product:row.service.name,currency:row.tariff.currency};
  return {label:formatBillingCopy(text.label,values),description:formatBillingCopy(text.description,values)};
}

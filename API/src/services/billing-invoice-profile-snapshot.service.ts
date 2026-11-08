import type { Prisma } from '@prisma/client';

function profileSnapshot(profile:{id:string;legalName:string;billingEmail:string;taxIdentifier:string|null}) {
  return {profile_id:profile.id,legal_name:profile.legalName,billing_email:profile.billingEmail,tax_identifier:profile.taxIdentifier};
}

export function invoiceIssuerSnapshot(profile:{id:string;legalName:string;billingEmail:string;taxIdentifier:string|null;
  tradingName:string|null;address:Prisma.JsonValue;companyRegistrationNumber:string|null}) {
  return {...profileSnapshot(profile),trading_name:profile.tradingName,address:profile.address,
    company_registration_number:profile.companyRegistrationNumber};
}

export function invoiceBuyerSnapshot(profile:{id:string;legalName:string;billingEmail:string;taxIdentifier:string|null;
  billingAddress:Prisma.JsonValue;purchaseOrderReference:string|null}) {
  return {...profileSnapshot(profile),billing_address:profile.billingAddress,purchase_order_reference:profile.purchaseOrderReference};
}

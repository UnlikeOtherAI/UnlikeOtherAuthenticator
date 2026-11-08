import type { PrismaClient } from '@prisma/client';
import type { BillingOrganisationFinancialDto as FinancialDto,BillingCustomerInvoiceDetailV1,
  BillingCustomerInvoicesListV1 } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import type { BillingCycleContext } from './billing-cycle-read.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { listOrganisationInvoices,getOrganisationInvoice,downloadOrganisationInvoice } from './billing-organisation-invoices.service.js';

/** One financial read authority for every request family. Old non-null subjects
 * retain their strict shape; their selected team never filters financial rows. */
export async function listCustomerInvoices(context:BillingCycleContext,
  params:{chargeMonth:string;limit?:number;cursor?:string},deps?:{prisma?:PrismaClient;now?:Date}):
Promise<FinancialDto<BillingCustomerInvoicesListV1>> {
  return listOrganisationInvoices(context,params,deps?.prisma??getAdminPrisma(),deps?.now);
}
export async function getCustomerInvoiceDetail(context:BillingCycleContext,id:string,
  deps?:{prisma?:PrismaClient;chargeMonth?:string}):Promise<FinancialDto<BillingCustomerInvoiceDetailV1>> {
  return getOrganisationInvoice(context,id,deps?.prisma??getAdminPrisma(),deps?.chargeMonth);
}
export async function downloadCustomerInvoice(context:BillingCycleContext,id:string,documentId:string,
  deps?:{prisma?:PrismaClient;storage?:ReturnType<typeof createBillingInvoicePdfStorage>}):
Promise<{bytes:Buffer;contentType:'application/pdf';filename:string}> {
  return downloadOrganisationInvoice(context,id,documentId,deps?.prisma??getAdminPrisma(),deps?.storage);
}

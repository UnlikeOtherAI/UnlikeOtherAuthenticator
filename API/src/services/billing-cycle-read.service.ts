import type { BillingOrganisationFinancialDto as FinancialDto } from '../contracts/billing-statement-v1.js';
import { createHash } from 'node:crypto';

import { type Prisma, type PrismaClient } from '@prisma/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import {
  BILLING_CYCLES_DOWNLOAD_PATH,
  billingCycleDetailV2JsonSchema, billingOrganisationFinancialV1Schemas,
  type BillingCycleDetailV2 as PublicBillingCycleDetailV2,
  type BillingCycleSummaryV2 as PublicBillingCycleSummaryV2,
  type BillingCyclesListV2 as PublicBillingCyclesListV2,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { localizeBillingCycleDetail } from './billing-cycle-display.service.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { BillingCycleSubject } from './billing-cycle-authority.service.js';
import { compareBillingCycleUtf8 } from './billing-cycle-binary-order.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { listOrganisationCycles,readOrganisationCycle,downloadOrganisationCycle } from './billing-organisation-cycles.service.js';
import { organisationHistorySubject } from './billing-organisation-history.service.js';
import type { OrganisationHistorySelection } from './billing-organisation-history.service.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validate = validator.compile(billingCycleDetailV2JsonSchema);
const validateFinancial=validator.compile(billingOrganisationFinancialV1Schemas.cycle_detail_response);

export type BillingCycleContext = OrganisationHistorySelection & {
  credential: VerifiedBillingAppKey;
  actorToken: string;
  locale?: BillingCustomerLocale;
  endpoint: BillingActorEndpoint;
  request: BillingCycleSubject;
};

type CycleRow = Prisma.BillingCustomerCycleGetPayload<{
  include: { documents: true };
}>;

function publicSubject(context: BillingCycleContext) {
  return {
    product: context.request.product,
    organisation_id: context.request.organisationId,
    team_id: context.request.teamId,
    user_id: context.request.userId,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => compareBillingCycleUtf8(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function billingCycleSnapshotDigest(publicSnapshot: unknown, privateEvidence: unknown): string {
  return createHash('sha256').update(canonicalJson({ publicSnapshot, privateEvidence })).digest('hex');
}

export function hydrateBillingCycle(row: CycleRow, context: BillingCycleContext,
  product:Pick<typeof context.credential.service,'id'|'identifier'>=context.credential.service): BillingCycleDetailV2 {
  if (billingCycleSnapshotDigest(row.publicSnapshot, row.privateEvidence) !== row.snapshotSha256) {
    throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_SNAPSHOT_INTEGRITY');
  }
  const value = row.publicSnapshot as unknown as BillingCycleDetailV2;
  const startsAt = new Date(`${row.billingMonth}-01T00:00:00.000Z`);
  const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
  if (!value || value.cycle_id !== row.id || value.period.month !== row.billingMonth ||
      value.period.starts_at !== startsAt.toISOString() ||
      value.period.ends_at !== endsAt.toISOString() ||
      value.scope.organisation_id !== row.orgId || value.scope.team_id !== row.teamId ||
      value.scope.cycle_scope !== (row.teamId === null ? 'organisation' : 'team') ||
      value.scope.payer_scope !== row.payerScope.toLowerCase() ||
      value.correction_of_cycle_id === row.id ||
      value.state !== row.state || value.product.id !== row.serviceId ||
      value.product.identifier !== product.identifier || value.product.id !== product.id ||
      value.documents.length !== row.documents.length ||
      value.document_available !== (row.documents.length > 0)) {
    throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_SNAPSHOT_BINDING');
  }
  const documents = new Map(row.documents.map((document) => [document.id, document]));
  const detail: BillingCycleDetailV2 = {
    ...value,
    document_available: row.documents.length > 0,
    documents: value.documents.map((document) => {
      const recorded = documents.get(document.document_id);
      if (!recorded || recorded.kind !== document.kind || recorded.format !== document.format ||
          recorded.invoiceNumber !== document.number ||
          (recorded.issuedAt?.toISOString() ?? null) !== document.issued_at ||
          (recorded.amountMinor?.toString() ?? null) !==
            (document.customer_total?.amount_minor ?? null) ||
          (recorded.currency ?? null) !== (document.customer_total?.currency ?? null)) {
        throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_DOCUMENT_BINDING');
      }
      return {
        ...document,
        state: 'available' as const,
        download_action: {
          method: 'POST' as const,
          path: BILLING_CYCLES_DOWNLOAD_PATH,
          body: { ...(context.financialScope?organisationHistorySubject(context):publicSubject(context)), cycle_id: row.id, document_id: recorded.id },
        },
      };
    }),
  };
  if (!(context.financialScope?validateFinancial:validate)(detail)) throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_CONTRACT_INVALID');
  return localizeBillingCycleDetail(detail, context.locale);
}

export function billingCycleSummary(detail: BillingCycleDetailV2): BillingCycleSummaryV2 {
  return {
    cycle_id: detail.cycle_id,
    ...(detail.correction_of_cycle_id ?
      { correction_of_cycle_id: detail.correction_of_cycle_id } : {}),
    period: detail.period,
    state: detail.state,
    scope: detail.scope,
    product: detail.product,
    totals: detail.totals,
    document_available: detail.document_available,
  };
}

/** History is organisation-wide. The selected team remains actor context. */
export async function listBillingCycles(context:BillingCycleContext,params:{limit?:number;cursor?:string},
  deps?:{prisma?:PrismaClient;now?:Date}):Promise<BillingCyclesListV2> {
  return listOrganisationCycles(context,params,deps?.prisma??getAdminPrisma(),deps?.now);
}
export async function getBillingCycleDetail(context:BillingCycleContext,id:string,
  deps?:{prisma?:PrismaClient;now?:Date}):Promise<BillingCycleDetailV2> {
  return (await readOrganisationCycle(context,id,deps?.prisma??getAdminPrisma())).detail;
}
export async function downloadBillingCycleDocument(context:BillingCycleContext,id:string,documentId:string,
  deps?:{prisma?:PrismaClient;storage?:ReturnType<typeof createBillingInvoicePdfStorage>}):
Promise<{bytes:Buffer;contentType:'application/pdf'|'text/csv';filename:string}> {
  return downloadOrganisationCycle(context,id,documentId,deps?.prisma??getAdminPrisma(),deps?.storage);
}
type BillingCycleDetailV2=FinancialDto<PublicBillingCycleDetailV2>;
type BillingCycleSummaryV2=FinancialDto<PublicBillingCycleSummaryV2>;
type BillingCyclesListV2=FinancialDto<PublicBillingCyclesListV2>;

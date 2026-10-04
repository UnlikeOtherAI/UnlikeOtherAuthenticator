import { createHash } from 'node:crypto';

import { BillingAssignmentScope, type Prisma, type PrismaClient } from '@prisma/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';

import {
  BILLING_CYCLES_DOWNLOAD_PATH,
  billingCycleDetailV2JsonSchema,
  type BillingCycleDetailV2,
  type BillingCycleSummaryV2,
  type BillingCyclesListV2,
} from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { authorizeBillingCycle, type BillingCycleSubject } from './billing-cycle-authority.service.js';
import { createBillingInvoicePdfStorage } from './billing-invoice-storage.service.js';
import { resolveBillingControlledBy } from './billing-org-responsibility.service.js';

const validator = new Ajv2020({ allErrors: true, strict: true });
ajvFormats.default.default(validator);
const validate = validator.compile(billingCycleDetailV2JsonSchema);

export type BillingCycleContext = {
  credential: VerifiedBillingAppKey;
  actorToken: string;
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
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function billingCycleSnapshotDigest(publicSnapshot: unknown, privateEvidence: unknown): string {
  return createHash('sha256').update(canonicalJson({ publicSnapshot, privateEvidence })).digest('hex');
}

function hydrate(row: CycleRow, context: BillingCycleContext): BillingCycleDetailV2 {
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
      value.state !== row.state || value.product.id !== row.serviceId ||
      value.product.identifier !== context.credential.service.identifier ||
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
          body: { ...publicSubject(context), cycle_id: row.id, document_id: recorded.id },
        },
      };
    }),
  };
  if (!validate(detail)) throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_CONTRACT_INVALID');
  return detail;
}

function summary(detail: BillingCycleDetailV2): BillingCycleSummaryV2 {
  return {
    cycle_id: detail.cycle_id,
    period: detail.period,
    state: detail.state,
    scope: detail.scope,
    product: detail.product,
    totals: detail.totals,
    document_available: detail.document_available,
  };
}

function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const cursorPattern = /^(\d{4}-(?:0[1-9]|1[0-2])):(team|organisation)$/;

function cycleOrder(row: CycleRow): number {
  return row.teamId === null ? 1 : 0;
}

function cycleCursor(row: CycleRow): string {
  return `${row.billingMonth}:${row.teamId === null ? 'organisation' : 'team'}`;
}

function preview(
  context: BillingCycleContext, now: Date, payerScope: 'team' | 'organisation',
): BillingCycleDetailV2 {
  const month = currentMonth(now);
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    schema_version: 2,
    cycle_id: `preview:${month}:team`,
    period: { month, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() },
    state: 'open_preview',
    scope: { organisation_id: context.request.organisationId,
      team_id: context.request.teamId, cycle_scope: 'team', payer_scope: payerScope },
    product: { id: context.credential.service.id, identifier: context.request.product,
      name: context.credential.service.name },
    totals: [], document_available: false, subscription_lines: [], usage_lines: [],
    credits: { consumed: '0', opening_balance: null, closing_balance: null,
      status: 'pending_reconciliation' },
    documents: [], adjustments: [],
  };
}

export async function listBillingCycles(
  context: BillingCycleContext,
  params: { limit?: number; cursor?: string },
  deps?: { prisma?: PrismaClient; now?: Date },
): Promise<BillingCyclesListV2> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const viewer = await authorizeBillingCycle(context, { prisma });
  const now = deps?.now ?? new Date();
  const limit = params.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CYCLE_LIMIT_INVALID');
  }
  if (params.cursor && !cursorPattern.test(params.cursor)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CYCLE_CURSOR_INVALID');
  }
  const orgManager = viewer.organisationRole === 'owner' || viewer.organisationRole === 'admin';
  const cursor = params.cursor?.match(cursorPattern);
  const scope = { serviceId: context.credential.service.id,
    orgId: context.request.organisationId,
    ...(cursor ? { billingMonth: { lte: cursor[1] } } : {}) };
  const findScope = (teamId: string | null) => prisma.billingCustomerCycle.findMany({
    where: { ...scope, teamId,
      ...(!orgManager ? { payerScope: BillingAssignmentScope.TEAM } : {}) },
    orderBy: [{ billingMonth: 'desc' }, { revision: 'desc' }],
    distinct: ['billingMonth'], take: limit + 2, include: { documents: true },
  });
  const [teamRows, orgRows] = await Promise.all([
    findScope(context.request.teamId), orgManager ? findScope(null) : Promise.resolve([]),
  ]);
  const rows = [...teamRows, ...orgRows]
    .sort((a, b) => b.billingMonth.localeCompare(a.billingMonth) || cycleOrder(a) - cycleOrder(b))
    .filter((row) => !cursor || row.billingMonth < cursor[1] ||
      (row.billingMonth === cursor[1] && cycleOrder(row) >
        (cursor[2] === 'team' ? 0 : 1)));
  const controlledBy = params.cursor ? null : await resolveBillingControlledBy({
    organisationId: context.request.organisationId, userId: context.request.userId,
  }, { prisma });
  const previewScope = controlledBy ? 'organisation' : 'team';
  const hasCurrent = rows.some((row) => row.billingMonth === currentMonth(now) &&
    row.teamId === context.request.teamId);
  const includePreview = !params.cursor && !hasCurrent;
  const selected = rows.slice(0, includePreview ? Math.max(0, limit - 1) : limit);
  const cycles = selected.map((row) => summary(hydrate(row, context)));
  if (includePreview) cycles.unshift(summary(preview(context, now, previewScope)));
  const hasMore = rows.length > selected.length;
  const last = selected.at(-1);
  return {
    schema_version: 2, generated_at: now.toISOString(), subject: publicSubject(context),
    cycles,
    next_cursor: hasMore ? last ? cycleCursor(last) :
      `${currentMonth(now)}:team` : null,
  };
}

export async function getBillingCycleDetail(
  context: BillingCycleContext,
  cycleId: string,
  deps?: { prisma?: PrismaClient; now?: Date },
): Promise<BillingCycleDetailV2> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  await authorizeBillingCycle(context, { prisma });
  const now = deps?.now ?? new Date();
  if (cycleId === `preview:${currentMonth(now)}:team`) {
    const controlledBy = await resolveBillingControlledBy({
      organisationId: context.request.organisationId, userId: context.request.userId,
    }, { prisma });
    if (controlledBy) {
      await authorizeBillingCycle({ ...context, payerScope: BillingAssignmentScope.ORGANISATION },
        { prisma });
    }
    return preview(context, now, controlledBy ? 'organisation' : 'team');
  }
  const row = await prisma.billingCustomerCycle.findFirst({
    where: { id: cycleId, serviceId: context.credential.service.id,
      orgId: context.request.organisationId,
      OR: [{ teamId: context.request.teamId }, { teamId: null }] },
    include: { documents: true },
  });
  if (!row) throw new AppError('NOT_FOUND', 404, 'BILLING_CYCLE_NOT_FOUND');
  if (row.teamId === null || row.payerScope === BillingAssignmentScope.ORGANISATION) {
    await authorizeBillingCycle({ ...context, payerScope: row.payerScope }, { prisma });
  }
  return hydrate(row, context);
}

export async function downloadBillingCycleDocument(
  context: BillingCycleContext,
  cycleId: string,
  documentId: string,
  deps?: { prisma?: PrismaClient; storage?: ReturnType<typeof createBillingInvoicePdfStorage> },
): Promise<{ bytes: Buffer; contentType: 'application/pdf' | 'text/csv'; filename: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  await authorizeBillingCycle(context, { prisma });
  const document = await prisma.billingCustomerCycleDocument.findFirst({
    where: { id: documentId, cycleId, cycle: { serviceId: context.credential.service.id,
      orgId: context.request.organisationId,
      OR: [{ teamId: context.request.teamId }, { teamId: null }] } },
    include: { cycle: { include: { documents: true } } },
  });
  if (!document) throw new AppError('NOT_FOUND', 404, 'BILLING_CYCLE_DOCUMENT_NOT_FOUND');
  if (document.cycle.teamId === null ||
      document.cycle.payerScope === BillingAssignmentScope.ORGANISATION) {
    await authorizeBillingCycle({ ...context, payerScope: document.cycle.payerScope }, { prisma });
  }
  hydrate(document.cycle, context);
  const bytes = await (deps?.storage ?? createBillingInvoicePdfStorage()).read(document.objectKey);
  if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
    throw new AppError('INTERNAL', 503, 'BILLING_CYCLE_DOCUMENT_INTEGRITY');
  }
  return {
    bytes, contentType: document.format === 'pdf' ? 'application/pdf' : 'text/csv',
    filename: `billing-${document.cycle.billingMonth}-${document.kind}.${document.format}`,
  };
}

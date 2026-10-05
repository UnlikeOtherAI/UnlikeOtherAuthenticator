import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { getAdminPrisma } from '../../../db/prisma.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { prepareManualInvoiceCreditNote } from
  '../../../services/billing-manual-credit-note-prepare.service.js';
import { getManualCreditNoteForInvoice, issueManualCreditNote,
  readManualCreditNotePdf } from
  '../../../services/billing-manual-credit-note-issuer.service.js';
import { AppError } from '../../../utils/errors.js';

const identifier = z.string().trim().min(1).max(256);
const invoiceParams = z.object({ invoiceId: identifier }).strict();
const noteParams = z.object({ creditNoteId: identifier }).strict();
const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
  onSend: async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  },
};

function actor(request: FastifyRequest) {
  const claims = request.adminAccessTokenClaims;
  if (!claims) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  return { userId: claims.userId, tokenVersion: claims.tokenVersion, email: claims.email };
}

function response(note: { id: string; originalInvoiceId: string;
  status: string; creditNoteNumber: string | null; issuedAt: Date | null;
  netCreditMinor: bigint; taxCreditMinor: bigint; totalCreditMinor: bigint;
  currency: string; reason: string }) {
  return { id: note.id, original_invoice_id: note.originalInvoiceId,
    status: note.status.toLowerCase(), number: note.creditNoteNumber,
    issued_at: note.issuedAt?.toISOString() ?? null,
    net_credit_minor: note.netCreditMinor.toString(),
    tax_credit_minor: note.taxCreditMinor.toString(),
    total_credit_minor: note.totalCreditMinor.toString(),
    currency: note.currency, reason: note.reason };
}

export function registerManualCreditNoteRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/billing/invoices/:invoiceId/credit-note',
    adminRoute, async (request) => {
      const { invoiceId } = invoiceParams.parse(request.params);
      const note = await getManualCreditNoteForInvoice(invoiceId);
      return { credit_note: note ? response(note) : null };
    });

  app.post('/internal/admin/billing/invoices/:invoiceId/credit-note/prepare',
    adminRoute, async (request, reply) => {
      const { invoiceId } = invoiceParams.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(1).max(500) })
        .strict().parse(request.body);
      const prepared = await prepareManualInvoiceCreditNote({ invoiceId,
        reason: body.reason, actor: actor(request) });
      const note = await getManualCreditNoteForInvoice(invoiceId);
      if (!note || note.id !== prepared.id) {
        throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_NOTE_PREPARE_MISSING');
      }
      return reply.status(201).send({ credit_note: response(note) });
    });

  app.post('/internal/admin/billing/credit-notes/:creditNoteId/issue',
    adminRoute, async (request) => {
      const { creditNoteId } = noteParams.parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      await issueManualCreditNote({ creditNoteId, actor: actor(request) });
      const note = await getAdminPrisma().billingManualCreditNote.findUnique({ where: {
        id: creditNoteId,
      } });
      if (!note) throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_NOTE_ISSUE_MISSING');
      return { credit_note: response(note) };
    });

  app.get('/internal/admin/billing/credit-notes/:creditNoteId/pdf',
    adminRoute, async (request, reply) => {
      const { creditNoteId } = noteParams.parse(request.params);
      const { value, filename } = await readManualCreditNotePdf(creditNoteId);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(value);
    });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { completeSigningContinuation } from '../../services/signature-continuation.service.js';
import {
  readSigningAgreementSource,
  readSigningReceipt,
  readSigningSession,
  signAgreementVersion,
  type SigningSessionState,
} from '../../services/signature-signing.service.js';

const TokenSchema = z.string().min(24).max(512);
const SessionBodySchema = z.object({ signing_token: TokenSchema }).strict();
const VersionBodySchema = SessionBodySchema.extend({
  agreement_version_id: z.string().min(1).max(200),
}).strict();
const SignBodySchema = VersionBodySchema.extend({
  accepted: z.boolean(),
  typed_name: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const ReceiptBodySchema = SessionBodySchema.extend({
  signature_id: z.string().min(1).max(200),
}).strict();

function ipRateKey(prefix: string, request: FastifyRequest): string {
  return `${prefix}:ip:${request.ip || 'unknown'}`;
}

const sessionRateLimit = createRateLimiter({
  keyBuilder: (request) => ipRateKey('signature-session', request),
  limit: 120,
  windowMs: 5 * 60 * 1000,
});
const sourceRateLimit = createRateLimiter({
  keyBuilder: (request) => ipRateKey('signature-source', request),
  limit: 120,
  windowMs: 5 * 60 * 1000,
});
const signRateLimit = createRateLimiter({
  keyBuilder: (request) => ipRateKey('signature-sign', request),
  limit: 20,
  windowMs: 5 * 60 * 1000,
});
const receiptRateLimit = createRateLimiter({
  keyBuilder: (request) => ipRateKey('signature-session-receipt', request),
  limit: 60,
  windowMs: 60 * 60 * 1000,
});
const completeRateLimit = createRateLimiter({
  keyBuilder: (request) => ipRateKey('signature-complete', request),
  limit: 20,
  windowMs: 5 * 60 * 1000,
});

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Pragma', 'no-cache');
}

function safeFilename(value: string): string {
  return value.replace(/["\\\r\n]/gu, '_');
}

function formatSession(session: SigningSessionState) {
  return {
    domain: session.domain,
    expires_at: session.expiresAt.toISOString(),
    initial_policy_revision: session.initialPolicyRevision,
    policy_revision: session.policyRevision,
    complete: session.complete,
    agreements: session.agreements.map((agreement) => ({
      agreement_id: agreement.agreementId,
      agreement_version_id: agreement.agreementVersionId,
      agreement_title: agreement.agreementTitle,
      title: agreement.title,
      description: agreement.description,
      version: agreement.version,
      original_filename: agreement.originalFilename,
      signing_method: agreement.signingMethod.toLowerCase(),
      acceptance_statement: agreement.acceptanceStatement,
      source_pdf_sha256: agreement.sourcePdfSha256,
    })),
    receipts: session.receipts.map((receipt) => ({
      signature_id: receipt.signatureId,
      agreement_title: receipt.agreementTitle,
      version: receipt.version,
      verification_reference: receipt.verificationReference,
      receipt_pdf_sha256: receipt.receiptPdfSha256,
      signed_at: receipt.signedAt.toISOString(),
      revoked: receipt.revoked,
    })),
  };
}

export function registerSignatureSessionRoutes(app: FastifyInstance): void {
  app.post('/signatures/session', { preHandler: [sessionRateLimit] }, async (request, reply) => {
    const { signing_token } = SessionBodySchema.parse(request.body);
    const session = await readSigningSession(signing_token);
    noStore(reply);
    return { ok: true, ...formatSession(session) };
  });

  app.post('/signatures/session/source', { preHandler: [sourceRateLimit] }, async (request, reply) => {
    const body = VersionBodySchema.parse(request.body);
    const source = await readSigningAgreementSource({
      signingToken: body.signing_token,
      agreementVersionId: body.agreement_version_id,
    });
    noStore(reply);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `inline; filename="${safeFilename(source.filename)}"; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
      )
      .header('ETag', `"sha256-${source.sha256}"`)
      .send(source.value);
  });

  app.post(
    '/signatures/session/sign',
    { preHandler: [signRateLimit, requireSameOriginBrowserRequest] },
    async (request, reply) => {
    const body = SignBodySchema.parse(request.body);
    const signature = await signAgreementVersion({
      signingToken: body.signing_token,
      agreementVersionId: body.agreement_version_id,
      accepted: body.accepted,
      typedName: body.typed_name,
      ipAddress: request.ip ?? null,
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 1000)
          : null,
    });
    const session = await readSigningSession(body.signing_token);
    noStore(reply);
    return {
      ok: true,
      signature_id: signature.id,
      verification_reference: signature.verificationReference,
      receipt_pdf_sha256: signature.receiptPdfSha256,
      session: formatSession(session),
    };
    },
  );

  app.post('/signatures/session/receipt', { preHandler: [receiptRateLimit] }, async (request, reply) => {
    const body = ReceiptBodySchema.parse(request.body);
    const receipt = await readSigningReceipt({
      signingToken: body.signing_token,
      signatureId: body.signature_id,
    });
    noStore(reply);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `attachment; filename="${safeFilename(receipt.filename)}"; filename*=UTF-8''${encodeURIComponent(receipt.filename)}`,
      )
      .header('ETag', `"sha256-${receipt.sha256}"`)
      .send(receipt.value);
  });

  app.post(
    '/signatures/session/complete',
    { preHandler: [completeRateLimit, requireSameOriginBrowserRequest] },
    async (request, reply) => {
      const { signing_token } = SessionBodySchema.parse(request.body);
      const outcome = await completeSigningContinuation(signing_token);
      noStore(reply);
      return {
        ok: true,
        complete: outcome.status === 'granted',
        signatures_required: outcome.status === 'signing_required' ? true : undefined,
        redirect_to: outcome.redirectTo,
      };
    },
  );
}

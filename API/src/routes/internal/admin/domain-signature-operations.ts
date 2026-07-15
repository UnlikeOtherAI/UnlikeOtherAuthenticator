import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createRateLimiter } from '../../../middleware/rate-limiter.js';
import {
  readAdminSignatureReceipt,
  revokeAgreementSignature,
  searchAgreementSignatures,
} from '../../../services/signature-admin-operations.service.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const DomainParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
});
const SignatureParamsSchema = DomainParamsSchema.extend({
  signatureId: z.string().trim().min(1).max(200),
});
const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(320).optional(),
    agreement_id: z.string().trim().min(1).max(200).optional(),
    agreement_version_id: z.string().trim().min(1).max(200).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const RevokeBodySchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const objectSchema = { type: 'object', additionalProperties: true } as const;

function requireActorEmail(request: FastifyRequest): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

function rateKey(prefix: string, request: FastifyRequest): string {
  const params = DomainParamsSchema.safeParse(request.params);
  return `${prefix}:${request.adminAccessTokenClaims?.email ?? request.ip}:${
    params.success ? params.data.domain : 'unknown'
  }`;
}

const searchRateLimit = createRateLimiter({
  keyBuilder: (request) => rateKey('admin-signature-search', request),
  limit: 120,
  windowMs: 60 * 1000,
});
const receiptRateLimit = createRateLimiter({
  keyBuilder: (request) => rateKey('admin-signature-receipt', request),
  limit: 60,
  windowMs: 60 * 60 * 1000,
});

function adminRoute(preHandler = [requireAdminSuperuser]): RouteShorthandOptions {
  return { preHandler, schema: { response: { 200: objectSchema } } };
}

function formatSignature(row: Record<string, unknown> & {
  version: Record<string, unknown> & { agreement: Record<string, unknown> };
  revocation: Record<string, unknown> | null;
}) {
  return {
    id: row.id,
    verification_reference: row.verificationReference,
    user_id: row.userId,
    user_email: row.userEmail,
    signer_name: row.signerName,
    domain: row.domain,
    agreement_id: row.version.agreementId,
    agreement_title: row.version.agreement.title,
    agreement_version_id: row.agreementVersionId,
    agreement_version: row.version.version,
    signing_method: String(row.signingMethod).toLowerCase(),
    typed_name: row.typedName,
    acceptance_statement: row.acceptanceStatement,
    source_pdf_sha256: row.sourcePdfSha256,
    auth_method: row.authMethod,
    two_fa_completed: row.twoFaCompleted,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    evidence_manifest_sha256: row.evidenceManifestSha256,
    receipt_pdf_sha256: row.receiptPdfSha256,
    evidence_key_id: row.evidenceKeyId,
    signed_at: row.signedAt instanceof Date ? row.signedAt.toISOString() : row.signedAt,
    revocation: row.revocation
      ? {
          actor_email: row.revocation.actorEmail,
          reason: row.revocation.reason,
          revoked_at:
            row.revocation.revokedAt instanceof Date
              ? row.revocation.revokedAt.toISOString()
              : row.revocation.revokedAt,
        }
      : null,
  };
}

export function registerInternalAdminDomainSignatureOperationRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/domains/:domain/signatures/records',
    adminRoute([requireAdminSuperuser, searchRateLimit]),
    async (request) => {
      const { domain } = DomainParamsSchema.parse(request.params);
      const query = SearchQuerySchema.parse(request.query);
      const results = await searchAgreementSignatures({
        domain,
        query: query.q,
        agreementId: query.agreement_id,
        agreementVersionId: query.agreement_version_id,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { data: results.data.map(formatSignature), next_cursor: results.nextCursor };
    },
  );

  app.get(
    '/internal/admin/domains/:domain/signatures/records/:signatureId/receipt',
    { preHandler: [requireAdminSuperuser, receiptRateLimit] },
    async (request, reply) => {
      const params = SignatureParamsSchema.parse(request.params);
      const receipt = await readAdminSignatureReceipt({
        ...params,
        actorEmail: requireActorEmail(request),
      });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${receipt.filename}"`)
        .header('ETag', `"sha256-${receipt.sha256}"`)
        .send(receipt.value);
    },
  );

  app.post(
    '/internal/admin/domains/:domain/signatures/records/:signatureId/revoke',
    adminRoute(),
    async (request) => {
      const params = SignatureParamsSchema.parse(request.params);
      const body = RevokeBodySchema.parse(request.body);
      const revocation = await revokeAgreementSignature({
        ...params,
        reason: body.reason,
        actorEmail: requireActorEmail(request),
      });
      return {
        id: revocation.id,
        signature_id: revocation.signatureId,
        actor_email: revocation.actorEmail,
        reason: revocation.reason,
        revoked_at: revocation.revokedAt.toISOString(),
      };
    },
  );
}

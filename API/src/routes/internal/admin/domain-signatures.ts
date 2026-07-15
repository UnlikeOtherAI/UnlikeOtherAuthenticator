import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';

import { getEnv } from '../../../config/env.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createRateLimiter } from '../../../middleware/rate-limiter.js';
import {
  deleteDraftAgreementVersion,
  readAgreementVersionSource,
  replaceDraftAgreementVersionPdf,
  updateDraftAgreementVersion,
  uploadDraftAgreementVersion,
} from '../../../services/signature-agreement-lifecycle.service.js';
import {
  publishAgreementVersion,
  withdrawAgreementVersion,
} from '../../../services/signature-agreement-publication.service.js';
import {
  createAgreement,
  getSignatureAdminOverview,
  updateAgreement,
  updateSignatureSettings,
} from '../../../services/signature-admin.service.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const DomainParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
});
const AgreementParamsSchema = DomainParamsSchema.extend({
  agreementId: z.string().trim().min(1).max(200),
});
const VersionParamsSchema = AgreementParamsSchema.extend({
  versionId: z.string().trim().min(1).max(200),
});
const SettingsBodySchema = z
  .object({
    enabled: z.boolean(),
    retention_days: z.number().int().min(1).max(36_500).nullable(),
  })
  .strict();
const AgreementBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullable().default(null),
    display_order: z.number().int().min(0).max(100_000).default(0),
    required_for_access: z.boolean().default(true),
  })
  .strict();
const VersionMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    signing_method: z.enum(['clickwrap', 'typed_name']),
    acceptance_statement: z.string().trim().min(1).max(4000),
  })
  .strict();
const PublishBodySchema = z
  .object({ effective_at: z.coerce.date().optional() })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;

function requireActorEmail(request: FastifyRequest): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

function uploadRateKey(request: FastifyRequest): string {
  const params = DomainParamsSchema.safeParse(request.params);
  return `admin-signature-upload:${request.adminAccessTokenClaims?.email ?? request.ip}:${
    params.success ? params.data.domain : 'unknown'
  }`;
}

const uploadRateLimit = createRateLimiter({
  keyBuilder: uploadRateKey,
  limit: 20,
  windowMs: 60 * 60 * 1000,
});

function adminRoute(responseSchema: Record<string, unknown> = objectSchema): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function uploadRoute(): RouteShorthandOptions {
  return {
    bodyLimit: getEnv().SIGNATURE_MAX_PDF_BYTES + 32 * 1024,
    preHandler: [requireAdminSuperuser, uploadRateLimit],
    schema: { response: { 200: objectSchema, 201: objectSchema } },
  };
}

function multipartValue(file: MultipartFile, name: string): string {
  const field = file.fields[name];
  if (!field || Array.isArray(field) || field.type !== 'field' || typeof field.value !== 'string') {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_UPLOAD');
  }
  return field.value;
}

async function pdfUpload(request: FastifyRequest): Promise<{ file: MultipartFile; value: Buffer }> {
  try {
    const file = await request.file();
    if (!file || file.fieldname !== 'file' || file.mimetype !== 'application/pdf') {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_UPLOAD');
    }
    const value = await file.toBuffer();
    return { file, value };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError('BAD_REQUEST', 413, 'PDF_TOO_LARGE');
    }
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_UPLOAD');
  }
}

function signingMethod(value: 'clickwrap' | 'typed_name'): 'CLICKWRAP' | 'TYPED_NAME' {
  return value === 'typed_name' ? 'TYPED_NAME' : 'CLICKWRAP';
}

function formatVersion(version: Record<string, unknown> & { _count?: { signatures: number } }) {
  return {
    id: version.id,
    version: version.version,
    title: version.title,
    original_filename: version.originalFilename,
    source_pdf_sha256: version.sourcePdfSha256,
    signing_method: String(version.signingMethod).toLowerCase(),
    acceptance_statement: version.acceptanceStatement,
    status: String(version.status).toLowerCase(),
    published_at: version.publishedAt instanceof Date ? version.publishedAt.toISOString() : null,
    effective_at: version.effectiveAt instanceof Date ? version.effectiveAt.toISOString() : null,
    published_by_email: version.publishedByEmail ?? null,
    created_at: version.createdAt instanceof Date ? version.createdAt.toISOString() : version.createdAt,
    signature_count: version._count?.signatures ?? undefined,
  };
}

function formatAgreement(agreement: Record<string, unknown> & { versions?: Record<string, unknown>[] }) {
  return {
    id: agreement.id,
    title: agreement.title,
    description: agreement.description,
    display_order: agreement.displayOrder,
    required_for_access: agreement.requiredForAccess,
    created_at: agreement.createdAt instanceof Date ? agreement.createdAt.toISOString() : agreement.createdAt,
    updated_at: agreement.updatedAt instanceof Date ? agreement.updatedAt.toISOString() : agreement.updatedAt,
    versions: agreement.versions?.map(formatVersion) ?? undefined,
  };
}

function formatSettings(settings: Record<string, unknown>) {
  return {
    enabled: settings.enabled,
    policy_revision: settings.policyRevision,
    retention_days: settings.retentionDays,
    created_at: settings.createdAt instanceof Date ? settings.createdAt.toISOString() : null,
    updated_at: settings.updatedAt instanceof Date ? settings.updatedAt.toISOString() : null,
  };
}

function downloadFilename(value: string): string {
  return value.replace(/["\\\r\n]/gu, '_');
}

export function registerInternalAdminDomainSignatureRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/domains/:domain/signatures', adminRoute(), async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const overview = await getSignatureAdminOverview(domain);
    return {
      settings: formatSettings(overview.settings),
      agreements: overview.agreements.map(formatAgreement),
      audit_events: overview.auditEvents.map((event) => ({
        id: event.id,
        actor_email: event.actorEmail,
        action: event.action,
        target_type: event.targetType,
        target_id: event.targetId,
        metadata: event.metadata,
        created_at: event.createdAt.toISOString(),
      })),
    };
  });

  app.put('/internal/admin/domains/:domain/signatures/settings', adminRoute(), async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const body = SettingsBodySchema.parse(request.body);
    const settings = await updateSignatureSettings({
      domain,
      enabled: body.enabled,
      retentionDays: body.retention_days,
      actorEmail: requireActorEmail(request),
    });
    return formatSettings(settings);
  });

  app.post('/internal/admin/domains/:domain/signatures/agreements', adminRoute(), async (request, reply) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const body = AgreementBodySchema.parse(request.body);
    const agreement = await createAgreement({
      domain,
      title: body.title,
      description: body.description,
      displayOrder: body.display_order,
      requiredForAccess: body.required_for_access,
      actorEmail: requireActorEmail(request),
    });
    return reply.status(201).send(formatAgreement(agreement));
  });

  app.put('/internal/admin/domains/:domain/signatures/agreements/:agreementId', adminRoute(), async (request) => {
    const { domain, agreementId } = AgreementParamsSchema.parse(request.params);
    const body = AgreementBodySchema.parse(request.body);
    return formatAgreement(
      await updateAgreement({
        domain,
        agreementId,
        title: body.title,
        description: body.description,
        displayOrder: body.display_order,
        requiredForAccess: body.required_for_access,
        actorEmail: requireActorEmail(request),
      }),
    );
  });

  app.post('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions', uploadRoute(), async (request, reply) => {
    const { domain, agreementId } = AgreementParamsSchema.parse(request.params);
    const upload = await pdfUpload(request);
    const metadata = VersionMetadataSchema.parse({
      title: multipartValue(upload.file, 'title'),
      signing_method: multipartValue(upload.file, 'signing_method'),
      acceptance_statement: multipartValue(upload.file, 'acceptance_statement'),
    });
    const version = await uploadDraftAgreementVersion({
      domain,
      agreementId,
      title: metadata.title,
      originalFilename: upload.file.filename,
      signingMethod: signingMethod(metadata.signing_method),
      acceptanceStatement: metadata.acceptance_statement,
      sourcePdf: upload.value,
      actorEmail: requireActorEmail(request),
    });
    return reply.status(201).send(formatVersion(version));
  });

  app.put('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId', adminRoute(), async (request) => {
    const params = VersionParamsSchema.parse(request.params);
    const body = VersionMetadataSchema.parse(request.body);
    return formatVersion(
      await updateDraftAgreementVersion({
        ...params,
        title: body.title,
        signingMethod: signingMethod(body.signing_method),
        acceptanceStatement: body.acceptance_statement,
        actorEmail: requireActorEmail(request),
      }),
    );
  });

  app.put('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId/source', uploadRoute(), async (request) => {
    const params = VersionParamsSchema.parse(request.params);
    const upload = await pdfUpload(request);
    return formatVersion(
      await replaceDraftAgreementVersionPdf({
        ...params,
        originalFilename: upload.file.filename,
        sourcePdf: upload.value,
        actorEmail: requireActorEmail(request),
      }),
    );
  });

  app.post('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId/publish', adminRoute(), async (request) => {
    const params = VersionParamsSchema.parse(request.params);
    const body = PublishBodySchema.parse(request.body ?? {});
    return formatVersion(
      await publishAgreementVersion({
        ...params,
        effectiveAt: body.effective_at ?? new Date(),
        actorEmail: requireActorEmail(request),
      }),
    );
  });

  app.post('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId/withdraw', adminRoute(), async (request) => {
    const params = VersionParamsSchema.parse(request.params);
    return formatVersion(
      await withdrawAgreementVersion({ ...params, actorEmail: requireActorEmail(request) }),
    );
  });

  app.delete('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const params = VersionParamsSchema.parse(request.params);
    await deleteDraftAgreementVersion({ ...params, actorEmail: requireActorEmail(request) });
    return reply.status(204).send();
  });

  app.get('/internal/admin/domains/:domain/signatures/agreements/:agreementId/versions/:versionId/source', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const params = VersionParamsSchema.parse(request.params);
    const source = await readAgreementVersionSource(params);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `attachment; filename="${downloadFilename(source.filename)}"; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
      )
      .header('ETag', `"sha256-${source.sha256}"`)
      .send(source.value);
  });
}

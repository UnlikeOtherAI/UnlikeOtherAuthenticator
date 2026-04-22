import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../../config/env.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { sendIntegrationApprovedEmail } from '../../../services/email.service.js';
import {
  createAdminDomain,
  type DomainMutationResult,
  rotateAdminDomainSecret,
  updateAdminDomain,
} from '../../../services/domain-secret.service.js';
import { getAppLogger } from '../../../utils/app-logger.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const DomainParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
});

const DomainCreateSchema = z
  .object({
    domain: z.string().trim().min(3).transform(normalizeDomain),
    label: z.string().trim().min(1).max(120).optional(),
    client_secret: z.string().trim().min(32).optional(),
  })
  .strict();

const DomainUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const DomainRotateSchema = z
  .object({
    client_secret: z.string().trim().min(32).optional(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const mutationSchema = {
  type: 'object',
  required: ['domain'],
  additionalProperties: false,
  properties: {
    domain: objectSchema,
    client_secret: { type: 'string' },
    client_hash: { type: 'string' },
    client_hash_prefix: { type: 'string' },
  },
} as const;

const rotateResponseSchema = {
  type: 'object',
  required: ['domain', 'contact_email', 'email_dispatched', 'hash_prefix'],
  additionalProperties: false,
  properties: {
    domain: { type: 'string' },
    contact_email: { type: 'string' },
    email_dispatched: { type: 'boolean' },
    hash_prefix: { type: 'string' },
  },
} as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function displayDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toAdminDomain(row: DomainMutationResult['domain']) {
  const activeSecret = row.secrets[0] ?? null;
  return {
    id: row.domain,
    name: row.domain,
    label: row.label,
    secretAge: activeSecret ? 'today' : null,
    secretOld: false,
    users: 0,
    orgs: 0,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created: displayDate(row.createdAt),
    hash: activeSecret ? `sha256:${activeSecret.hashPrefix}...` : 'not configured',
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

function resolveClaimBaseUrl(): string {
  const env = getEnv();
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `http://${env.HOST}:${env.PORT}`;
}

function buildClaimUrl(rawToken: string): string {
  return `${resolveClaimBaseUrl()}/integrations/claim/${encodeURIComponent(rawToken)}`;
}

async function dispatchRotationClaimEmail(params: {
  to: string;
  link: string;
  domain: string;
}): Promise<boolean> {
  try {
    await sendIntegrationApprovedEmail(params);
    return true;
  } catch (err) {
    getAppLogger().error(
      { err, domain: params.domain },
      'failed to dispatch domain secret rotation claim email',
    );
    return false;
  }
}

export function registerInternalAdminDomainRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/domains', adminRoute(mutationSchema), async (request) => {
    const body = DomainCreateSchema.parse(request.body);
    const actorEmail = requireActorEmail(request);
    const result = await createAdminDomain({
      domain: body.domain,
      label: body.label,
      clientSecret: body.client_secret,
      actorEmail,
    });

    return {
      domain: toAdminDomain(result.domain),
      client_secret: result.clientSecret,
      client_hash: result.clientHash,
      client_hash_prefix: result.clientHashPrefix,
    };
  });

  app.put('/internal/admin/domains/:domain', adminRoute(objectSchema), async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const body = DomainUpdateSchema.parse(request.body);
    const actorEmail = requireActorEmail(request);
    return toAdminDomain(
      await updateAdminDomain({ domain, label: body.label, status: body.status, actorEmail }),
    );
  });

  app.post(
    '/internal/admin/domains/:domain/rotate-secret',
    adminRoute(rotateResponseSchema),
    async (request) => {
      const { domain } = DomainParamsSchema.parse(request.params);
      const body = DomainRotateSchema.parse(request.body ?? {});
      const actorEmail = requireActorEmail(request);

      const result = await rotateAdminDomainSecret({
        domain,
        clientSecret: body.client_secret,
        actorEmail,
      });

      const emailDispatched = await dispatchRotationClaimEmail({
        to: result.contactEmail,
        link: buildClaimUrl(result.claim.rawToken),
        domain: result.domain,
      });

      return {
        domain: result.domain,
        contact_email: result.contactEmail,
        email_dispatched: emailDispatched,
        hash_prefix: result.hashPrefix,
      };
    },
  );
}

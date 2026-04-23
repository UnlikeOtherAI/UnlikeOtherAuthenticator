import type { DomainEmailConfig } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  getSesStatus,
  hasDedicatedSesAdminCredentials,
  hasSesAdminRuntimeCredentials,
  registerSesSender,
  type SesRegistration,
} from './ses-admin.service.js';

type DomainEmailFields = {
  mailingDomain: string;
  fromAddress: string;
  fromName?: string | null;
  replyToDefault?: string | null;
};

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function serialize(config: DomainEmailConfig | null) {
  if (!config) return null;
  return {
    domain: config.domain,
    enabled: config.enabled,
    mailingDomain: config.mailingDomain,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    replyToDefault: config.replyToDefault,
    sesRegion: config.sesRegion,
    sesVerification: config.sesVerification,
    sesDkim: config.sesDkim,
    sesVerificationToken: config.sesVerificationToken,
    dkimTokens: config.dkimTokens,
    lastCheckedAt: config.lastCheckedAt?.toISOString() ?? null,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

function dnsRecords(config: DomainEmailConfig | null) {
  if (!config?.mailingDomain) return null;
  return {
    verification: config.sesVerificationToken
      ? { record: `_amazonses.${config.mailingDomain} TXT "${config.sesVerificationToken}"` }
      : null,
    dkim: config.dkimTokens.map((token) => ({
      cname: `${token}._domainkey.${config.mailingDomain}`,
      value: `${token}.dkim.amazonses.com`,
    })),
  };
}

export async function getDomainEmailConfig(domain: string) {
  const normalized = normalizeDomain(domain);
  const prisma = getAdminPrisma();
  const existing = await prisma.domainEmailConfig.findUnique({ where: { domain: normalized } });
  let current = existing;
  if (existing?.mailingDomain && existing.dkimTokens.length > 0 && hasSesAdminRuntimeCredentials()) {
    const status = await getSesStatus(existing.mailingDomain);
    current = await prisma.domainEmailConfig.update({
      where: { domain: normalized },
      data: {
        sesVerification: status.verification,
        sesDkim: status.dkim,
        lastCheckedAt: new Date(),
      },
    });
  }

  return {
    config: serialize(current),
    liveStatus: current
      ? { verification: current.sesVerification, dkim: current.sesDkim }
      : { verification: null, dkim: null },
    dnsRecords: dnsRecords(current),
    adminCredentialsConfigured: hasDedicatedSesAdminCredentials(),
  };
}

export async function upsertDomainEmailConfig(domain: string, fields: DomainEmailFields) {
  const normalized = normalizeDomain(domain);
  const mailingDomain = normalizeDomain(fields.mailingDomain);
  const fromAddress = fields.fromAddress.trim().toLowerCase();
  if (!fromAddress.endsWith(`@${mailingDomain}`)) {
    throw new AppError('BAD_REQUEST', 400, 'FROM_ADDRESS_DOMAIN_MISMATCH');
  }

  const existing = await getAdminPrisma().domainEmailConfig.findUnique({ where: { domain: normalized } });
  const senderChanged = existing?.mailingDomain !== mailingDomain || existing?.fromAddress !== fromAddress;
  const config = await getAdminPrisma().domainEmailConfig.upsert({
    where: { domain: normalized },
    update: {
      mailingDomain,
      fromAddress,
      fromName: cleanOptional(fields.fromName),
      replyToDefault: cleanOptional(fields.replyToDefault),
      sesRegion: getEnv().AWS_SES_ADMIN_REGION ?? getEnv().AWS_REGION ?? 'eu-west-1',
      ...(senderChanged
        ? {
            enabled: false,
            sesVerification: null,
            sesDkim: null,
            sesVerificationToken: null,
            dkimTokens: [],
            lastCheckedAt: null,
          }
        : {}),
    },
    create: {
      domain: normalized,
      mailingDomain,
      fromAddress,
      fromName: cleanOptional(fields.fromName),
      replyToDefault: cleanOptional(fields.replyToDefault),
      sesRegion: getEnv().AWS_SES_ADMIN_REGION ?? getEnv().AWS_REGION ?? 'eu-west-1',
    },
  });

  return serialize(config);
}

export async function registerDomainEmailSender(domain: string): Promise<SesRegistration> {
  const normalized = normalizeDomain(domain);
  const config = await getAdminPrisma().domainEmailConfig.findUnique({ where: { domain: normalized } });
  if (!config?.mailingDomain) throw new AppError('BAD_REQUEST', 400);

  const registration = await registerSesSender(config.mailingDomain);
  await getAdminPrisma().domainEmailConfig.update({
    where: { domain: normalized },
    data: {
      sesVerification: 'Pending',
      sesDkim: 'Pending',
      sesVerificationToken: registration.verification.record.match(/"([^"]+)"/)?.[1] ?? null,
      dkimTokens: registration.dkim.map((record) =>
        record.cname.replace(`._domainkey.${config.mailingDomain}`, ''),
      ),
      lastCheckedAt: new Date(),
    },
  });

  return registration;
}

export async function refreshDomainEmailStatus(domain: string) {
  const normalized = normalizeDomain(domain);
  const config = await getAdminPrisma().domainEmailConfig.findUnique({ where: { domain: normalized } });
  if (!config?.mailingDomain) throw new AppError('NOT_FOUND', 404);

  const status = await getSesStatus(config.mailingDomain);
  const updated = await getAdminPrisma().domainEmailConfig.update({
    where: { domain: normalized },
    data: {
      sesVerification: status.verification,
      sesDkim: status.dkim,
      lastCheckedAt: new Date(),
    },
  });

  return { config: serialize(updated), ...status };
}

export async function setDomainEmailEnabled(domain: string, enabled: boolean) {
  const normalized = normalizeDomain(domain);
  const config = await getAdminPrisma().domainEmailConfig.findUnique({ where: { domain: normalized } });
  if (!config) throw new AppError('NOT_FOUND', 404);
  if (enabled && (config.sesVerification !== 'Success' || config.sesDkim !== 'Success')) {
    throw new AppError('FORBIDDEN', 403, 'EMAIL_DOMAIN_NOT_VERIFIED');
  }

  return serialize(
    await getAdminPrisma().domainEmailConfig.update({
      where: { domain: normalized },
      data: { enabled },
    }),
  );
}

export async function deleteDomainEmailConfig(domain: string): Promise<void> {
  await getAdminPrisma().domainEmailConfig.delete({
    where: { domain: normalizeDomain(domain) },
  });
}

export async function requireSendableDomainEmailConfig(domain: string) {
  const config = await getAdminPrisma().domainEmailConfig.findUnique({
    where: { domain: normalizeDomain(domain) },
  });
  if (
    !config?.enabled ||
    config.sesVerification !== 'Success' ||
    config.sesDkim !== 'Success' ||
    !config.fromAddress
  ) {
    throw new AppError('FORBIDDEN', 403);
  }
  return config;
}

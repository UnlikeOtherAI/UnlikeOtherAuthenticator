import type { PrismaClient } from '@prisma/client';

import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { getAppLogger } from '../utils/app-logger.js';
import { sendIntegrationRequestNotificationEmail } from './email.service.js';

type NotifyPrisma = Pick<PrismaClient, 'domainRole'>;

function prismaClient(deps?: { prisma?: NotifyPrisma }): NotifyPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as NotifyPrisma);
}

function resolveAdminUrl(requestId: string): string {
  const env = getEnv();
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') ?? `http://${env.HOST}:${env.PORT}`;
  return `${base}/admin/integrations?focus=${encodeURIComponent(requestId)}`;
}

export async function listSuperuserEmailsInAdminDomain(
  deps?: { prisma?: NotifyPrisma },
): Promise<string[]> {
  const adminDomain = normalizeDomain(getAdminAuthDomain());
  const rows = await prismaClient(deps).domainRole.findMany({
    where: { domain: adminDomain, role: 'SUPERUSER' },
    include: { user: { select: { email: true } } },
  });
  const emails = new Set<string>();
  for (const row of rows) {
    const email = row.user?.email?.trim();
    if (email) emails.add(email.toLowerCase());
  }
  return [...emails];
}

/**
 * Fan out a notification email to every superuser of the admin domain when a new
 * PENDING integration request is created. Fire-and-forget per recipient: failures
 * are logged but never propagated, because the caller runs in a public `/auth`
 * code path that must not block on SES.
 *
 * Only the create path should call this; re-polls of an already-pending request
 * (`updated` / `unchanged` outcomes) must not generate additional emails.
 */
export function dispatchNewIntegrationRequestNotification(params: {
  requestId: string;
  domain: string;
  contactEmail: string;
}): void {
  const logger = getAppLogger();
  void (async () => {
    let recipients: string[];
    try {
      recipients = await listSuperuserEmailsInAdminDomain();
    } catch (err) {
      logger.error(
        { err, domain: params.domain, requestId: params.requestId },
        'failed to resolve superuser recipients for integration request notification',
      );
      return;
    }

    if (recipients.length === 0) {
      logger.warn(
        { domain: params.domain, requestId: params.requestId },
        'no superuser recipients found for integration request notification',
      );
      return;
    }

    const adminUrl = resolveAdminUrl(params.requestId);

    await Promise.all(
      recipients.map(async (to) => {
        try {
          await sendIntegrationRequestNotificationEmail({
            to,
            domain: params.domain,
            contactEmail: params.contactEmail,
            adminUrl,
          });
        } catch (err) {
          logger.error(
            { err, to, domain: params.domain, requestId: params.requestId },
            'failed to send integration request notification email',
          );
        }
      }),
    );
  })();
}

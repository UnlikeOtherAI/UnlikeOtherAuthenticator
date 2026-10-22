import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';

const TargetsSchema = z.array(z.object({
  domain: z.string().min(1),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }),
  secret: z.string().min(32),
}).strict()).max(50).superRefine((targets, context) => {
  if (new Set(targets.map((target) => target.domain)).size !== targets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'One directory endpoint per domain is required' });
  }
});
export type DirectoryWebhookTarget = z.infer<typeof TargetsSchema>[number];
type EventRow = { id: string; domain: string; org_id: string; team_id: string; subject: string; created_at: Date };

export function parseDirectoryWebhookTargets(value: string | undefined): DirectoryWebhookTarget[] {
  return TargetsSchema.parse(value ? JSON.parse(value) : []);
}

/** Dedicated per-product secret; no reusable domain or identity credential crosses this boundary. */
export function signDirectoryWebhook(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function deliverDirectoryWebhooks(input: {
  targets: DirectoryWebhookTarget[];
  prisma?: PrismaClient;
  fetch?: typeof fetch;
}): Promise<number> {
  if (!input.targets.length) return 0;
  const prisma = input.prisma ?? getAdminPrisma();
  const rows = await prisma.$queryRaw<EventRow[]>`
    UPDATE directory_webhook_events SET lease_until = now() + interval '2 minutes', attempts = attempts + 1
    WHERE id IN (SELECT id FROM directory_webhook_events
      WHERE delivered_at IS NULL AND next_attempt_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
        AND domain = ANY(${input.targets.map((target) => target.domain)})
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 20)
    RETURNING id,domain,org_id,team_id,subject,created_at
  `;
  let delivered = 0;
  for (const row of rows) {
    const target = input.targets.find((candidate) => candidate.domain === row.domain);
    if (!target) continue;
    const body = JSON.stringify({ id: row.id, type: 'person.changed', version: 1,
      occurredAt: row.created_at.toISOString(), domain: row.domain,
      organizationId: row.org_id, teamId: row.team_id, subject: row.subject });
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await (input.fetch ?? fetch)(target.url, { method: 'POST', body,
        redirect: 'error', signal: AbortSignal.timeout(5_000), headers: {
          'content-type': 'application/json', 'x-uoa-timestamp': timestamp,
          'x-uoa-signature': signDirectoryWebhook(body, timestamp, target.secret),
        } });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Directory endpoint refused delivery');
      await prisma.$executeRaw`UPDATE directory_webhook_events SET delivered_at=now(), lease_until=NULL
        WHERE id=${row.id}::uuid`;
      delivered += 1;
    } catch {
      // Retain the exact event until acknowledged; retries never manufacture a new event id.
      await prisma.$executeRaw`UPDATE directory_webhook_events SET lease_until=NULL,
        next_attempt_at=now()+least(300, power(2, least(attempts,8))) * interval '1 second'
        WHERE id=${row.id}::uuid AND delivered_at IS NULL`;
    }
  }
  return delivered;
}

export function startDirectoryWebhookDelivery(input: {
  log: { error: (details: object, message: string) => void };
}): { stop: () => Promise<void> } {
  const targets = parseDirectoryWebhookTargets(getEnv().DIRECTORY_WEBHOOK_TARGETS_JSON);
  let running: Promise<void> | undefined;
  const run = () => {
    if (running || !targets.length) return;
    running = deliverDirectoryWebhooks({ targets }).then(() => undefined).catch((error: unknown) => {
      input.log.error({ error }, 'Directory webhook delivery failed');
    }).finally(() => { running = undefined; });
  };
  run();
  const timer = setInterval(run, 500);
  timer.unref();
  return { stop: async () => { clearInterval(timer); await running; } };
}

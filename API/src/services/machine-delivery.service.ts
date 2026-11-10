import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { machineEqual, machineHash, machineRefused } from './machine-crypto.js';
import { machineClock, machineTransaction } from './machine-authority.service.js';
import { decodeMachineCursor, machineFeed } from './machine-events.service.js';
import { openEnterpriseSecret } from './enterprise-secret.service.js';
import { enterpriseFetch } from './enterprise-http.service.js';
import { signRevocationDelivery } from './org-sso-revocation.service.js';

export const MachineConsumerCapabilities = z.object({ version: z.literal(1), exact_binding: z.literal(true),
  monotonic_versions: z.literal(true), idempotent_events: z.literal(true), deadline_fencing: z.literal(true),
  pull_reconciliation: z.literal(true), lossless_versions: z.literal(true) }).strict();
export const MachineReadyInput = z.object({ key_id: z.string().min(1).max(100),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), cursor: z.string().max(2000),
  capabilities: MachineConsumerCapabilities, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function machineReadinessTranscript(domain: string, input: Omit<z.infer<typeof MachineReadyInput>, 'proof'>) {
  return 'UOA-MACHINE-REVOCATION-READY-V1\n' + JSON.stringify({ client_domain: domain,
    key_id: input.key_id, challenge: input.challenge, cursor: input.cursor, capabilities: input.capabilities });
}
export async function machineReadyChallenge(domain: string) {
  const nonce = randomBytes(32).toString('base64url');
  return machineTransaction(async tx => {
    const consumer = await tx.orgRevocationConsumer.findUnique({ where: { clientDomain: domain } });
    if (!consumer?.enabled || !consumer.acknowledgedAt) machineRefused(409, 'MACHINE_CONSUMER_REQUIRED');
    const now = await machineClock(tx); const expiresAt = new Date(now.getTime() + 600_000);
    await tx.orgRevocationConsumer.update({ where: { clientDomain: domain }, data: {
      machineReadyChallengeHash: machineHash(nonce), machineReadyExpiresAt: expiresAt } });
    return { version: 1, key_id: consumer.keyId, challenge: nonce, expires_at: expiresAt.toISOString() };
  });
}
export async function acknowledgeMachineConsumer(domain: string, input: z.infer<typeof MachineReadyInput>) {
  // KMS/network work occurs outside the write transaction. CAS the exact secret/key below.
  const db = getAdminPrisma(); const consumer = await db.orgRevocationConsumer.findUnique({ where: { clientDomain: domain } });
  if (!consumer?.enabled || consumer.keyId !== input.key_id || !consumer.acknowledgedAt) machineRefused();
  const secret = await openEnterpriseSecret(consumer.encryptedSecret, `revocations:${domain}:${consumer.keyId}`);
  const expected = createHmac('sha256', secret).update(machineReadinessTranscript(domain, input)).digest('hex');
  if (!machineEqual(expected, input.proof)) machineRefused();
  return machineTransaction(async tx => {
    const now = await machineClock(tx); decodeMachineCursor(input.cursor, domain, now.getTime());
    const updated = await tx.orgRevocationConsumer.updateMany({ where: { clientDomain: domain, enabled: true,
      keyId: consumer.keyId, encryptedSecret: consumer.encryptedSecret, acknowledgedAt: consumer.acknowledgedAt,
      machineReadyChallengeHash: machineHash(input.challenge), machineReadyExpiresAt: { gt: now } },
      data: { machineCapabilityVersion: 1, machineCursor: input.cursor, machineReadyChallengeHash: null,
        machineReadyExpiresAt: null, machineFailureCount: 0, machineNextAttemptAt: now } });
    if (updated.count !== 1) machineRefused();
    return { ok: true, version: 1, machine_delivery_enabled: true };
  });
}
export async function deliverMachineEvents(shouldContinue: () => boolean = () => true) {
  const db = getAdminPrisma();
  const consumers = await db.orgRevocationConsumer.findMany({ where: { enabled: true, machineCapabilityVersion: 1,
    machineNextAttemptAt: { lte: new Date() }, machineCursor: { not: null } }, take: 10, orderBy: { machineNextAttemptAt: 'asc' } });
  for (const consumer of consumers) {
    if (!shouldContinue() || !consumer.machineCursor) return;
    try {
      const batch = await machineFeed(consumer.clientDomain, consumer.machineCursor, 20);
      const secret = await openEnterpriseSecret(consumer.encryptedSecret, `revocations:${consumer.clientDomain}:${consumer.keyId}`);
      for (const event of batch.events) {
        if (!shouldContinue()) return;
        const current = await db.orgRevocationConsumer.findUnique({ where: { clientDomain: consumer.clientDomain } });
        if (!current?.enabled || current.machineCapabilityVersion !== 1 || current.keyId !== consumer.keyId ||
          current.encryptedSecret !== consumer.encryptedSecret || current.machineCursor !== consumer.machineCursor ||
          current.destination !== consumer.destination) break;
        const body = JSON.stringify({ version: 1, capability: 'machine_enrollment_v1', audience: consumer.clientDomain, event });
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await enterpriseFetch(consumer.destination, [new URL(consumer.destination).origin], {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-uoa-revocation-key-id': consumer.keyId,
            'x-uoa-revocation-timestamp': String(timestamp),
            'x-uoa-revocation-signature': signRevocationDelivery(body, secret, timestamp) }, body, limit: 4096 });
        z.object({ ok: z.literal(true), version: z.literal(1), event_id: z.literal(event.id) }).strict().parse(JSON.parse(response));
      }
      if (!shouldContinue()) return;
      await db.orgRevocationConsumer.updateMany({ where: { clientDomain: consumer.clientDomain,
        machineCursor: consumer.machineCursor, machineCapabilityVersion: 1, enabled: true, keyId: consumer.keyId,
        encryptedSecret: consumer.encryptedSecret, destination: consumer.destination }, data: {
        machineCursor: batch.next_cursor, machineFailureCount: 0, machineNextAttemptAt: new Date(Date.now() + 5000) } });
    } catch (error) {
      const expired = error instanceof AppError && error.message === 'MACHINE_CURSOR_EXPIRED';
      const failures = Math.min(consumer.machineFailureCount + 1, 10);
      await db.orgRevocationConsumer.updateMany({ where: { clientDomain: consumer.clientDomain,
        machineCursor: consumer.machineCursor, keyId: consumer.keyId, encryptedSecret: consumer.encryptedSecret },
        data: { ...(expired ? { machineCapabilityVersion: 0 } : {}), machineFailureCount: failures,
          machineNextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** failures)) } });
    }
  }
}
export function startMachineEventDelivery(log: { error: (value: object, message: string) => void }) {
  let stopped = false; let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = deliverMachineEvents(() => !stopped).catch(() => {
      log.error({ code: 'MACHINE_EVENT_DELIVERY_UNAVAILABLE' }, 'Machine event delivery unavailable');
    }).finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 5000); timer.unref(); tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}

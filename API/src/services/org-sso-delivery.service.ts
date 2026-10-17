import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { clientServiceContainsUrl } from '../utils/client-service.js';
import { enterpriseFetch } from './enterprise-http.service.js';
import { openEnterpriseSecret, sealEnterpriseSecret } from './enterprise-secret.service.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { publicRevocationEvent, signRevocationDelivery } from './org-sso-revocation.service.js';

export function revocationReadinessProof(secret: string, domain: string, keyId: string, challenge: string) {
  return createHmac('sha256', secret).update(`uoa.revocation-ready.v1\n${domain}\n${keyId}\n${challenge}`).digest('hex');
}

/** Operator provisioning is machine-only. A generated independent key is shown once. */
export async function registerRevocationConsumer(input: { client_domain: string; destination: string; key_id: string }) {
  const target = new URL(input.destination);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
    !clientServiceContainsUrl(input.client_domain, input.destination)) {
    throw new AppError('BAD_REQUEST', 400, 'REVOCATION_DESTINATION_INVALID');
  }
  const db = getAdminPrisma();
  const client = await db.clientDomain.findUnique({ where: { domain: input.client_domain } });
  if (!client || client.status !== 'active') throw new AppError('BAD_REQUEST', 400, 'REVOCATION_CLIENT_REQUIRED');
  const secret = randomBytes(32).toString('base64url');
  const challenge = randomBytes(32).toString('base64url');
  const encryptedSecret = await sealEnterpriseSecret(secret, `revocations:${input.client_domain}:${input.key_id}`);
  const data = { destination: input.destination, keyId: input.key_id, encryptedSecret, enabled: false,
    readyChallengeHash: hashAssuranceReference(challenge), readyChallengeExpiresAt: new Date(Date.now() + 3600000),
    acknowledgedAt: null, failureCount: 0 };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`revocation-consumer:${input.client_domain}`}, 0))`;
    await tx.orgRevocationConsumer.upsert({ where: { clientDomain: input.client_domain },
      create: { clientDomain: input.client_domain, ...data }, update: data });
  });
  return { ok: true, client_domain: input.client_domain, key_id: input.key_id, secret,
    challenge, challenge_expires_at: data.readyChallengeExpiresAt.toISOString(), delivery_enabled: false };
}

export async function acknowledgeRevocationConsumer(domain: string, input: { key_id: string; challenge: string; proof: string }) {
  const db = getAdminPrisma();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`revocation-consumer:${domain}`}, 0))`;
    const row = await tx.orgRevocationConsumer.findUnique({ where: { clientDomain: domain } });
    if (!row || row.keyId !== input.key_id || !row.readyChallengeHash || !row.readyChallengeExpiresAt ||
      row.readyChallengeExpiresAt <= new Date() || row.readyChallengeHash !== hashAssuranceReference(input.challenge)) {
      throw new AppError('FORBIDDEN', 403, 'REVOCATION_READINESS_INVALID');
    }
    const secret = await openEnterpriseSecret(row.encryptedSecret, `revocations:${domain}:${row.keyId}`);
    const expected = Buffer.from(revocationReadinessProof(secret, domain, row.keyId, input.challenge));
    const supplied = Buffer.from(input.proof);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AppError('FORBIDDEN', 403, 'REVOCATION_READINESS_INVALID');
    await tx.orgRevocationConsumer.update({ where: { clientDomain: domain }, data: {
      enabled: true, acknowledgedAt: new Date(), readyChallengeHash: null, readyChallengeExpiresAt: null,
      nextAttemptAt: new Date() } });
    return { ok: true, delivery_enabled: true, key_id: row.keyId };
  });
}

/** Durable cursor+receipts are committed only after the receiver durably acknowledges an event. */
export async function deliverEnterpriseRevocations(shouldContinue: () => boolean = () => true) {
  const db = getAdminPrisma();
  const consumers = await db.orgRevocationConsumer.findMany({ where: { enabled: true,
    acknowledgedAt: { not: null }, nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: 'asc' }, take: 10 });
  for (const consumer of consumers) {
    if (!shouldContinue()) return;
    const events = await db.orgRevocationEvent.findMany({ where: { clientDomain: consumer.clientDomain,
      sequence: { gt: consumer.deliveredSequence } }, orderBy: { sequence: 'asc' }, take: 20 });
    if (!events.length) continue;
    let delivered = consumer.deliveredSequence;
    try {
      const secret = await openEnterpriseSecret(consumer.encryptedSecret, `revocations:${consumer.clientDomain}:${consumer.keyId}`);
      for (const event of events) {
        if (!shouldContinue()) return;
        // Rotation/readiness revocation takes effect before each attempt, not just at the batch read.
        const current = await db.orgRevocationConsumer.findUniqueOrThrow({ where: { clientDomain: consumer.clientDomain } });
        if (!current.enabled || current.keyId !== consumer.keyId || !current.acknowledgedAt ||
          current.encryptedSecret !== consumer.encryptedSecret || current.destination !== consumer.destination) break;
        const body = JSON.stringify({ version: 1, audience: consumer.clientDomain, event: publicRevocationEvent(event) });
        const timestamp = Math.floor(Date.now() / 1000);
        const acknowledgement = await enterpriseFetch(consumer.destination, [new URL(consumer.destination).origin], { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-uoa-revocation-key-id': consumer.keyId,
            'x-uoa-revocation-timestamp': String(timestamp),
            'x-uoa-revocation-signature': signRevocationDelivery(body, secret, timestamp) }, body, limit: 4096 });
        const receipt = z.object({ ok: z.literal(true), version: z.literal(1), event_id: z.literal(event.id) })
          .strict().parse(JSON.parse(acknowledgement));
        if (!receipt.ok) throw new Error('REVOCATION_ACK_INVALID');
        await db.$transaction(async (tx) => {
          const updated = await tx.orgRevocationConsumer.updateMany({ where: { clientDomain: consumer.clientDomain,
            keyId: consumer.keyId, encryptedSecret: consumer.encryptedSecret, destination: consumer.destination,
            acknowledgedAt: consumer.acknowledgedAt, enabled: true, deliveredSequence: { lt: event.sequence } },
          data: { deliveredSequence: event.sequence, failureCount: 0, nextAttemptAt: new Date() } });
          if (updated.count) await tx.orgRevocationDelivery.upsert({ where: { clientDomain_eventId: {
            clientDomain: consumer.clientDomain, eventId: event.id } }, create: { clientDomain: consumer.clientDomain,
            eventId: event.id, keyId: consumer.keyId }, update: {} });
        });
        delivered = event.sequence;
      }
    } catch {
      // No raw response, provider payload, destination credential or secret goes into diagnostics.
      const failures = Math.min(consumer.failureCount + 1, 10);
      await db.orgRevocationConsumer.updateMany({ where: { clientDomain: consumer.clientDomain,
        keyId: consumer.keyId, encryptedSecret: consumer.encryptedSecret, destination: consumer.destination,
            acknowledgedAt: consumer.acknowledgedAt, enabled: true, deliveredSequence: { lte: delivered } }, data: {
        failureCount: failures, nextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** failures)) } });
    }
  }
}

export function startEnterpriseRevocationDelivery(log: { error: (value: unknown, message: string) => void }) {
  let busy = false;
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await deliverEnterpriseRevocations(() => !stopped); }
    catch { log.error({ code: 'ENTERPRISE_REVOCATION_DELIVERY_UNAVAILABLE' }, 'enterprise revocation delivery unavailable'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { if (!busy) running = tick(); }, 5000); timer.unref(); running = tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}

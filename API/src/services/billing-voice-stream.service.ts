import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingVoiceStreamRequestV1, BillingVoiceReservationV1 } from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { BillingVoiceProvider } from './billing-voice-provider.service.js';
import { voiceRow } from './billing-voice-dispatch.service.js';
import { publicVoiceReservation } from './billing-voice-reservation.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { voicePolicySchema } from './billing-voice-policy.service.js';

/** Trusted Nessie runtime duration evidence, not a Twilio price receipt. */
export async function recordVoiceStream(input: { request: BillingVoiceStreamRequestV1; credential: VerifiedBillingAppKey },
  deps: { prisma?: PrismaClient; voice: BillingVoiceProvider; now?: () => Date }): Promise<BillingVoiceReservationV1> {
  const prisma = deps.prisma ?? getAdminPrisma(); const body = input.request;
  const now = deps.now?.().getTime() ?? Date.now();
  const streamSid = `MZ${body.stream_sid.slice(2).toLowerCase()}`;
  const observed = await runBillingSerializableTransaction(prisma, tx => voiceRow(tx, body, input.credential,
    body.request_fingerprint), 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  // Independently verify the provider's exact CallSid/account/from/to/direction before accepting runtime evidence.
  await deps.voice.receipt({ accountSid: observed.accountSid, from: observed.from, to: observed.to,
    direction: observed.direction as 'inbound' | 'outbound' }, body.call_sid);
  return runBillingSerializableTransaction(prisma, async tx => {
    const row = await voiceRow(tx, body, input.credential, body.request_fingerprint);
    const quote = await tx.billingVoiceQuote.findUniqueOrThrow({ where: { id: row.quoteId } });
    const policy = voicePolicySchema.parse(quote.policyEvidence);
    if (!quote.streamEnabled || policy.featureProfile !== 'media_streams_fixed' || !row.dispatchClaimedAt || row.state === 'released'
      || (row.callSid && row.callSid !== body.call_sid)) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_STREAM_BINDING_CONFLICT');
    const start = new Date(body.started_at); const stop = body.stopped_at ? new Date(body.stopped_at) : null;
    if (!/^MZ[a-fA-F0-9]{32}$/.test(body.stream_sid) || !Number.isFinite(start.getTime())
      || (stop && !Number.isFinite(stop.getTime())) || (body.event === 'start') !== (stop === null)
      || start.getTime() < row.dispatchClaimedAt.getTime() - 1000 || start.getTime() > now + 5000
      || (stop && (stop < start || stop.getTime() > now + 5000))) {
      throw new AppError('BAD_REQUEST', 400, 'BILLING_VOICE_STREAM_TIME_INVALID');
    }
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stream:${row.accountSid}:${streamSid}`},0))::text`);
    const reused = await tx.billingVoiceStream.findUnique({ where: { accountSid_streamSid: {
      accountSid: row.accountSid, streamSid } } });
    const prior = await tx.billingVoiceStream.findUnique({ where: { reservationId: row.id } });
    if ((reused && reused.reservationId !== row.id) || (prior && (prior.streamSid !== streamSid
      || prior.callSid !== body.call_sid || prior.startedAt.getTime() !== start.getTime()))) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_STREAM_BINDING_CONFLICT');
    }
    if (body.event === 'start' && prior) return publicVoiceReservation(row);
    if (stop && prior?.stoppedAt) {
      if (prior.stoppedAt.getTime() !== stop.getTime()) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_STREAM_RECEIPT_CHANGED');
      return publicVoiceReservation(row);
    }
    if (row.state === 'settled' || (stop && !prior)) throw new AppError('BAD_REQUEST', 409, 'BILLING_VOICE_STREAM_START_REQUIRED');
    if (!row.callSid) await tx.billingVoiceReservation.update({ where: { id: row.id }, data: { callSid: body.call_sid } });
    if (!stop) await tx.billingVoiceStream.create({ data: { reservationId: row.id, serviceId: row.serviceId,
      accountSid: row.accountSid, callSid: body.call_sid, streamSid, startedAt: start } });
    else {
      const seconds = Math.ceil((stop.getTime() - start.getTime()) / 1000);
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      await tx.billingVoiceStream.update({ where: { reservationId: row.id }, data: { stoppedAt: stop,
        billedMinutes: minutes, fixedAmount: new Prisma.Decimal(policy.streamPricePerMinute).mul(minutes) } });
      if (seconds > row.maxDurationSeconds) return publicVoiceReservation(await tx.billingVoiceReservation.update({
        where: { id: row.id }, data: { state: 'reconciliation' } }));
    }
    return publicVoiceReservation({ ...row, callSid: body.call_sid });
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}

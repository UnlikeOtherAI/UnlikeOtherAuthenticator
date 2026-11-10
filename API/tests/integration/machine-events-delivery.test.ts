import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { machineHarness, machineConfigUrl, machineDomain, type MachineHarness } from '../helpers/machine-fixture.js';
import { machineHash, machineMac } from '../../src/services/machine-crypto.js';
import { sealEnterpriseSecret } from '../../src/services/enterprise-secret.service.js';
import { deliverMachineEvents } from '../../src/services/machine-delivery.service.js';
import { createApp } from '../../src/app.js';

function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
describe('machine v1 authenticated events, committed-prefix repair and durable push', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });
  async function checkpoint() {
    const response = await h.api('/revocations/checkpoint'); expect(response.statusCode, response.body).toBe(200);
    return response.json<{ next_cursor: string; high_water: string }>();
  }
  function feed(cursor: string, limit = 100) { return h.api('/revocations?' + new URLSearchParams({ cursor, limit: String(limit) }), {}, 'GET'); }

  it('replays exact immutable events and fences without admitting work, including after a server restart', async () => {
    const start = await checkpoint(); const f = await h.fixture(); const grant = await f.enrolled();
    const first = await feed(start.next_cursor); const duplicate = await feed(start.next_cursor);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().events).toEqual(duplicate.json().events);
    expect(first.json().events).toContainEqual(expect.objectContaining({ original_grant_id: grant.enrollmentId, source_version: '1' }));
    const id = first.json().events.find((row: { original_grant_id: string }) => row.original_grant_id === grant.enrollmentId).id as string;
    await expect(h.db.prisma.machineAuthorityEvent.update({ where: { id }, data: { reason: 'conflicting' } })).rejects.toThrow();
    const stored = await h.db.prisma.machineAuthorityEvent.findUniqueOrThrow({ where: { id } });
    await expect(h.db.prisma.machineAuthorityEvent.create({ data: { ...stored, id: randomUUID(), sequence: stored.sequence + 1000n } })).rejects.toThrow();
    const reconciled = await h.api('/reconcile', { enrollment_ids: [grant.enrollmentId, randomUUID()] });
    expect(reconciled.json()).toMatchObject({ admission: false, fences: [
      { original_grant_id: grant.enrollmentId, source_version: '1' }, { decision: 'unknown' },
    ] });
    const restarted = await createApp();
    try {
      const response = await restarted.inject({ method: 'GET', url: '/machine/v1/revocations?' + new URLSearchParams({
        domain: machineDomain, config_url: machineConfigUrl, cursor: start.next_cursor, limit: '100',
      }), headers: { authorization: `Bearer ${h.bearer}` } });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().events).toEqual(first.json().events);
    } finally { await restarted.close(); }
  });

  it('does not skip an earlier uncommitted event when a later transaction commits first', async () => {
    const first = await h.fixture(), second = await h.fixture();
    const a = await first.enrolled(), b = await second.enrolled(); const start = await checkpoint();
    const held = gate(), release = gate();
    const lateCommit = h.db.prisma.$transaction(async tx => {
      await tx.machineEnrollment.update({ where: { id: a.enrollmentId }, data: { status: 'revoked', reason: 'device_revoked', sourceVersion: { increment: 1 } } });
      held.open(); await release.promise;
    }, { timeout: 20_000 });
    await held.promise;
    try {
      await h.db.prisma.machineEnrollment.update({ where: { id: b.enrollmentId }, data: { status: 'revoked', reason: 'device_revoked', sourceVersion: { increment: 1 } } });
      const whileOpen = await feed(start.next_cursor);
      expect(whileOpen.json().events).not.toContainEqual(expect.objectContaining({ source_version: '2', original_grant_id: b.enrollmentId }));
      release.open(); await lateCommit;
      const after = await feed(whileOpen.json().next_cursor);
      expect(after.json().events.filter((event: { source_version: string }) => event.source_version === '2').map((event: { original_grant_id: string }) => event.original_grant_id))
        .toEqual([a.enrollmentId, b.enrollmentId]);
    } finally { release.open(); await lateCommit; }
  });

  it('requires checkpoint-before-walk repair for expired, corrupt or wrong-domain cursors', async () => {
    const start = await checkpoint();
    const [encoded] = start.next_cursor.split('.');
    const current = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    function altered(values: Record<string, unknown>) {
      const body = Buffer.from(JSON.stringify({ ...current, ...values })).toString('base64url');
      return `${body}.${machineMac('cursor', body)}`;
    }
    for (const cursor of [altered({ issued_at: Date.now() - 86_400_001 }), altered({ domain: 'other.example.com' }), start.next_cursor + 'x']) {
      const result = await feed(cursor); expect(result.statusCode).toBe(409); expect(result.json().code).toBe('MACHINE_CURSOR_EXPIRED');
      expect(result.json()).not.toHaveProperty('events');
    }
    const f = await h.fixture(); const grant = await f.enrolled(); const beforeWalk = await checkpoint();
    expect((await h.api('/reconcile', { enrollment_ids: [grant.enrollmentId] })).json().admission).toBe(false);
    await f.operate('revoke', grant.operation);
    const replay = await feed(beforeWalk.next_cursor, 1);
    expect(replay.json().events).toContainEqual(expect.objectContaining({ original_grant_id: grant.enrollmentId, decision: 'revoked', source_version: '2' }));
    expect(BigInt(replay.json().high_water)).toBeGreaterThanOrEqual(BigInt(beforeWalk.high_water));
  });

  it('authenticates explicit readiness and retries the same event identity after a lost acknowledgment', async () => {
    const start = await checkpoint(); const secret = randomBytes(32).toString('base64url'); const keyId = 'fictional-dedicated-key';
    const destination = `https://${machineDomain}/revocation-receiver`;
    await h.db.prisma.orgRevocationConsumer.create({ data: { clientDomain: machineDomain, keyId, destination,
      encryptedSecret: await sealEnterpriseSecret(secret, `revocations:${machineDomain}:${keyId}`), enabled: true, acknowledgedAt: new Date(), capabilityVersion: 1 } });
    const challenge = await h.api('/revocation-consumer/challenge'); expect(challenge.statusCode, challenge.body).toBe(200);
    const capabilities = { version: 1, exact_binding: true, monotonic_versions: true, idempotent_events: true,
      deadline_fencing: true, pull_reconciliation: true, lossless_versions: true };
    const input = { key_id: keyId, challenge: challenge.json().challenge as string, cursor: start.next_cursor, capabilities };
    const transcript = 'UOA-MACHINE-REVOCATION-READY-V1\n' + JSON.stringify({ client_domain: machineDomain, ...input });
    const proof = createHmac('sha256', secret).update(transcript).digest('hex');
    expect((await h.api('/revocation-consumer/ready', { ...input, proof: '0'.repeat(64) })).statusCode).toBe(401);
    const ready = await h.api('/revocation-consumer/ready', { ...input, proof }); expect(ready.statusCode, ready.body).toBe(200);
    const f = await h.fixture(); const grant = await f.enrolled();
    expect((await f.operate('rotate', grant.operation)).statusCode).toBe(200);
    const configFetch = globalThis.fetch; const accepted = new Map<string, string>(); const deliveries: string[] = [];
    let loseReply = true;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (target !== destination) return configFetch(url, options);
      const headers = new Headers(options?.headers), body = String(options?.body);
      const timestamp = headers.get('x-uoa-revocation-timestamp') ?? '';
      expect(headers.get('x-uoa-revocation-key-id')).toBe(keyId);
      expect(headers.get('x-uoa-revocation-signature')).toBe(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'));
      const payload = JSON.parse(body) as { capability: string; audience: string; event: { id: string } };
      expect(payload).toMatchObject({ capability: 'machine_enrollment_v1', audience: machineDomain });
      const digest = machineHash(JSON.stringify(payload.event));
      if (accepted.has(payload.event.id)) expect(accepted.get(payload.event.id)).toBe(digest);
      accepted.set(payload.event.id, digest); deliveries.push(payload.event.id);
      if (loseReply) { loseReply = false; return new Response('', { status: 503 }); }
      return new Response(JSON.stringify({ ok: true, version: 1, event_id: payload.event.id }), { status: 200 });
    }));
    try {
      await deliverMachineEvents();
      const failed = await h.db.prisma.orgRevocationConsumer.findUniqueOrThrow({ where: { clientDomain: machineDomain } });
      expect(failed.machineCursor).toBe(start.next_cursor); expect(failed.machineFailureCount).toBe(1);
      await h.db.prisma.orgRevocationConsumer.update({ where: { clientDomain: machineDomain }, data: { machineNextAttemptAt: new Date(0) } });
      await deliverMachineEvents();
      expect(deliveries[0]).toBe(deliveries[1]); expect(accepted.size).toBe(2);
      const repaired = await h.db.prisma.orgRevocationConsumer.findUniqueOrThrow({ where: { clientDomain: machineDomain } });
      expect(repaired.machineCursor).not.toBe(start.next_cursor); expect(repaired.machineFailureCount).toBe(0);
    } finally { vi.stubGlobal('fetch', configFetch); }
  });
});

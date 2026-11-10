import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { MachineGeneration, MachineSourceVersion, MachineTranscriptFields, MachineUnavailableOutcome, MachineRequestInput } from '../../src/services/machine-contract.js';
import { machineCanonicalJson, machineTranscript, verifyMachineProof } from '../../src/services/machine-crypto.js';
import { registerMachineHttpErrors } from '../../src/services/machine-http-errors.js';
import { AppError } from '../../src/utils/errors.js';
import { getPublicBaseUrl } from '../../src/config/env.js';

describe('machine v1 wire precision and typed proof boundary', () => {
  it('uses lossless canonical int64 source versions and bounded safe credential generations', () => {
    for (const value of ['1', '9007199254740993', '9223372036854775807']) expect(MachineSourceVersion.parse(value)).toBe(value);
    expect(BigInt(MachineSourceVersion.parse('9007199254740993'))).toBeGreaterThan(BigInt('9007199254740992'));
    for (const value of ['0', '01', '+1', '-1', '1.0', '1e2', ' 1', '9223372036854775808', 1]) expect(MachineSourceVersion.safeParse(value).success).toBe(false);
    for (const value of [0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1']) expect(MachineGeneration.safeParse(value).success).toBe(false);
    expect(MachineGeneration.parse(2147483647)).toBe(2147483647);
  });

  it('has one separate unavailable outcome and refuses fabricated authority fields', () => {
    const outcome = { decision: 'unavailable', reason: 'authority_unavailable' };
    expect(MachineUnavailableOutcome.parse(outcome)).toEqual(outcome);
    for (const extra of [{ source_version: '0' }, { original_grant_id: '00000000-0000-4000-8000-000000000000' },
      { credential_generation: 0 }, { version: 1 }, { recheck_by: new Date().toISOString() }]) {
      expect(MachineUnavailableOutcome.safeParse({ ...outcome, ...extra }).success).toBe(false);
    }
  });

  it('hashes the bounded RFC8785 profile without coercion, reordering ambiguity or invalid Unicode', () => {
    expect(machineCanonicalJson({ z: 1, a: 'Český počítač', absent: undefined, b: [true, null] }))
      .toBe('{"a":"Český počítač","b":[true,null],"z":1}');
    expect(() => machineCanonicalJson({ name: '\ud800' })).toThrow();
    expect(() => machineCanonicalJson({ generation: 1.5 })).toThrow();
    expect(() => machineCanonicalJson({ generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  it('matches the published fictional canonical request and exact UTF8 transcript fixture', async () => {
    const fixture = JSON.parse(await readFile(new URL('../../../Docs/Auth/fixtures/machine-enrollment-v1-proof.json', import.meta.url), 'utf8')) as {
      request: unknown; canonical_request: string; request_hash: string; transcript: string; transcript_sha256: string;
    };
    const request = MachineRequestInput.parse(fixture.request);
    expect(machineCanonicalJson({ operation: 'authorize', request })).toBe(fixture.canonical_request);
    expect(createHash('sha256').update(fixture.canonical_request, 'utf8').digest('hex')).toBe(fixture.request_hash);
    expect(createHash('sha256').update(fixture.transcript, 'utf8').digest('hex')).toBe(fixture.transcript_sha256);
    const fields = MachineTranscriptFields.parse(JSON.parse(fixture.transcript.slice('UOA-MACHINE-POP-V1\n'.length)));
    expect(fields).toMatchObject({ operation: 'authorize', request_id: request.request_id, request_hash: fixture.request_hash });
  });

  it('does not accept low-order public-key forgeries as proof of possession', () => {
    const identity = Buffer.alloc(32); identity[0] = 1;
    const orderTwo = Buffer.alloc(32, 255); orderTwo[0] = 236; orderTwo[31] = 127;
    const forged = Buffer.alloc(64); identity.copy(forged);
    for (const point of [Buffer.alloc(32), identity, orderTwo]) {
      const key = { kty: 'OKP', crv: 'Ed25519', x: point.toString('base64url') };
      for (let nonce = 0; nonce < 16; nonce++) {
        expect(() => verifyMachineProof(key, `UOA-MACHINE-POP-V1\nfictional-${nonce}`, forged.toString('base64url'))).toThrow();
      }
    }
  });

  it('signs exact validated protocol bytes rather than exposing a fixture arbitrary-text signer', () => {
    const keys = generateKeyPairSync('ed25519'); const requestId = randomUUID(), challengeId = randomUUID();
    const request = { request_id: requestId, operation_id: randomUUID(), subject: 'fictional-owner',
      audience: 'https://machine.example.com', organization_id: 'fictional-org', team_id: 'fictional-team',
      binding_id: 'fictional-authorization-binding', purpose: 'computer_connection' };
    const expectedDigest = createHash('sha256').update(machineCanonicalJson({ operation: 'recover', request })).digest('hex');
    const expiresAt = new Date(Date.now() + 60_000);
    const transcript = machineTranscript({ domain: 'machine.example.com', operation: 'recover', requestId,
      requestHash: expectedDigest, challengeId, expiresAt });
    const issuer = getPublicBaseUrl();
    // A test-only consumer of this producer's bytes; this proves no installed native signer.
    function signValidated(value: string) {
      if (!value.startsWith('UOA-MACHINE-POP-V1\n')) throw new Error('Unexpected protocol');
      const bytes = value.slice('UOA-MACHINE-POP-V1\n'.length);
      const fields = MachineTranscriptFields.parse(JSON.parse(bytes));
      // Compare to the producer's documented compact ordered form to reject
      // duplicate keys/ambiguous encodings; still sign the original validated bytes.
      if (JSON.stringify(fields) !== bytes) throw new Error('Unexpected producer encoding');
      if (fields.issuer !== issuer || fields.client_domain !== 'machine.example.com' || fields.operation !== 'recover' ||
        fields.request_id !== requestId || fields.challenge_id !== challengeId || fields.request_hash !== expectedDigest ||
        fields.expires_at !== expiresAt.toISOString() || Date.parse(fields.expires_at) <= Date.now()) throw new Error('Unexpected local operation');
      return sign(null, Buffer.from(value, 'utf8'), keys.privateKey).toString('base64url');
    }
    const signature = signValidated(transcript);
    const publicKey = keys.publicKey.export({ format: 'jwk' });
    expect(() => verifyMachineProof(publicKey, transcript, signature)).not.toThrow();
    expect(() => verifyMachineProof(publicKey, transcript.replace('{', '{ '), signature)).toThrow();
    for (const [field, value] of Object.entries({ issuer: 'https://attacker.example.com', client_domain: 'other.example.com',
      operation: 'rotate', request_id: randomUUID(), challenge_id: randomUUID(), request_hash: '0'.repeat(64),
      expires_at: new Date(0).toISOString() })) {
      const body = JSON.parse(transcript.slice('UOA-MACHINE-POP-V1\n'.length)) as Record<string, unknown>;
      body[field] = value;
      expect(() => signValidated('UOA-MACHINE-POP-V1\n' + JSON.stringify(body)), field).toThrow();
    }
    expect(() => signValidated('Please sign arbitrary text')).toThrow();
    expect(() => signValidated(transcript.replace('"issuer":', '"issuer":"https://attacker.example.com","issuer":'))).toThrow();
    expect(() => signValidated(transcript.replace('"version":1', '"version":1,"version":1'))).toThrow();
    expect(() => signValidated(transcript.replace('{', '{ '))).toThrow();
  });

  it('returns only typed unavailable for failures and never logs raw bound values, even with debug enabled', async () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
    const app = fastify({ disableRequestLogging: true, logger: { level: 'warn', stream } });
    registerMachineHttpErrors(app);
    app.post('/machine/v1/failure', async () => { throw new Error('private-token-and-profile-payload'); });
    app.post('/machine/v1/refused', async () => { throw new AppError('UNAUTHORIZED', 401, 'private-token-and-profile-payload'); });
    try {
      const unavailable = await app.inject({ method: 'POST', url: '/machine/v1/failure', payload: { credential: 'private-input' } });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ decision: 'unavailable', reason: 'authority_unavailable' });
      const refused = await app.inject({ method: 'POST', url: '/machine/v1/refused' });
      expect(refused.statusCode).toBe(401);
      expect(JSON.stringify(chunks)).not.toMatch(/private-token|private-input|profile-payload/);
      expect(refused.body).not.toContain('private-token');
    } finally { await app.close(); }
  });
});

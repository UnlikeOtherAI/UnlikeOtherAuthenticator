import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machineHarness, machineConfigUrl, machineDomain, machineOrigin, type MachineHarness } from '../helpers/machine-fixture.js';
import { hashSigningContinuationToken } from '../../src/services/signature-continuation.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';
import { FilesystemSignatureObjectStorage } from '../../src/services/signature-storage.service.js';

describe('machine agreement continuation preserves exact original opaque state in real PostgreSQL', () => {
  let h: MachineHarness; let storageRoot: string;
  const names = ['SIGNATURE_STORAGE_PROVIDER', 'SIGNATURE_FILESYSTEM_ROOT', 'SIGNATURE_EVIDENCE_PRIVATE_JWK', 'SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'uoa-machine-agreement-'));
    process.env.SIGNATURE_STORAGE_PROVIDER = 'filesystem'; process.env.SIGNATURE_FILESYSTEM_ROOT = storageRoot;
    process.env.SIGNATURE_EVIDENCE_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'machine-test-evidence', alg: 'RS256', use: 'sig' });
    process.env.SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON = JSON.stringify({ keys: [{ ...await exportJWK(publicKey), kid: 'machine-test-evidence', alg: 'RS256', use: 'sig' }] });
    h = await machineHarness();
    const document = await PDFDocument.create(); document.addPage([595, 842]).drawText('Fictional computer connection terms');
    const bytes = Buffer.from(await document.save()); const key = 'sources/fictional-machine-terms.pdf';
    await new FilesystemSignatureObjectStorage(storageRoot).putImmutable(key, bytes, 'application/pdf');
    await h.db.prisma.domainSignatureSettings.create({ data: { domain: machineDomain, enabled: true, policyRevision: 1, retentionDays: 365 } });
    const agreement = await h.db.prisma.agreement.create({ data: { domain: machineDomain, title: 'Fictional connection terms', requiredForAccess: true } });
    await h.db.prisma.agreementVersion.create({ data: { agreementId: agreement.id, version: 1,
      title: 'Fictional terms version 1', originalFilename: 'fictional-machine-terms.pdf', sourceStorageKey: key,
      sourcePdfSha256: hashPdf(bytes), signingMethod: 'CLICKWRAP', acceptanceStatement: 'I accept these fictional terms.',
      status: 'PUBLISHED', publishedAt: new Date(), effectiveAt: new Date(), publishedByEmail: 'operator@example.test' } });
  });
  afterAll(async () => {
    await h?.cleanup();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value;
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it('keeps nonempty CONFIG_JWT state through signing, then requires separate explicit consent without a product credential', async () => {
    const f = await h.fixture(); const intent = await f.request();
    expect((await h.api(`/authorization-requests/${intent.request_id}/proof`, { proof: f.proof(intent) })).statusCode).toBe(200);
    const started = await h.browser('/auth/machines/start', { login_token: await f.login(intent.request_id),
      request_id: intent.request_id, organization_id: f.org.id, team_id: f.team.id });
    expect(started.statusCode, started.body).toBe(200);
    const target = new URL(started.json().redirect_to as string);
    expect(target.pathname).toBe('/auth'); expect(target.searchParams.get('flow')).toBe('signatures');
    const token = target.searchParams.get('signing_token')!; expect(token).toBeTruthy();
    const continuation = await h.db.prisma.signingContinuation.findUniqueOrThrow({ where: {
      tokenHash: hashSigningContinuationToken(token, process.env.SHARED_SECRET!) } });
    expect(continuation).toMatchObject({ authProfile: 'CONFIG_JWT', oauthState: intent.request_id,
      configUrl: machineConfigUrl, oauthClientId: null, resource: null, oauthScope: null });
    expect(continuation.machineIntentId).toBeTruthy();
    const cookie = String(started.headers['set-cookie']).split(';')[0];
    const state = () => h.app.inject({ method: 'GET', url: '/auth/machines/state', headers: { cookie } });
    expect((await state()).statusCode).toBe(401);
    const post = (url: string, payload: object) => h.app.inject({ method: 'POST', url,
      headers: { origin: machineOrigin }, payload });
    const review = await post('/signatures/session', { signing_token: token });
    expect(review.statusCode, review.body).toBe(200);
    const versionId = review.json().agreements[0].agreement_version_id as string;
    const signed = await post('/signatures/session/sign', { signing_token: token, agreement_version_id: versionId, accepted: true });
    expect(signed.statusCode, signed.body).toBe(200);
    const completed = await post('/signatures/session/complete', { signing_token: token });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(new URL(completed.json().redirect_to as string).pathname).toBe('/auth/machines');
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(0);
    expect((await h.db.prisma.signingContinuation.findUniqueOrThrow({ where: { id: continuation.id } })).oauthState).toBe(intent.request_id);
    const ready = await state(); expect(ready.statusCode, ready.body).toBe(200);
    expect((await h.browser('/auth/machines/consent', { approved: true }, cookie, ready.json().csrf_token)).statusCode).toBe(200);
    expect(await h.db.prisma.machineEnrollment.count({ where: { subject: f.user.id } })).toBe(1);
    expect(await h.db.prisma.authorizationCode.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await h.db.prisma.refreshToken.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await h.db.prisma.sessionAssurance.count({ where: { userId: f.user.id } })).toBe(0);
    await expect(h.db.prisma.signingContinuation.update({ where: { id: continuation.id }, data: { oauthClientId: 'wrong-public-profile' } })).rejects.toThrow();
    await expect(h.db.prisma.signingContinuation.update({ where: { id: continuation.id }, data: {
      authProfile: 'PUBLIC_OAUTH', configUrl: null, oauthClientId: 'public-client-with-machine-intent' } })).rejects.toThrow();
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { exportJWK, generateKeyPair } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv, type Env } from '../../src/config/env.js';
import { consumeAuthorizationCode } from '../../src/services/authorization-code.service.js';
import { publishAgreementVersion } from '../../src/services/signature-agreement-publication.service.js';
import { revokeAgreementSignature } from '../../src/services/signature-admin-operations.service.js';
import {
  getCurrentSignatureStatus,
  verifyPublicSignatureReference,
} from '../../src/services/signature-access.service.js';
import {
  completeSigningContinuation,
  finalizeConfigAuthorizationWithSignatures,
  hashSigningContinuationToken,
} from '../../src/services/signature-continuation.service.js';
import { hashPdf } from '../../src/services/signature-pdf.service.js';
import {
  readSigningReceipt,
  readSigningSession,
  signAgreementVersion,
} from '../../src/services/signature-signing.service.js';
import { FilesystemSignatureObjectStorage } from '../../src/services/signature-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const SHARED_SECRET = 'signature-e2e-shared-secret-that-is-long-enough';
const DOMAIN = 'signatures.example.com';
const CONFIG_URL = `https://${DOMAIN}/auth-config`;
const REDIRECT_URL = `https://${DOMAIN}/oauth/callback?return=exact`;
const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');
const NOW = new Date('2026-07-15T21:00:00.000Z');

async function createPdf(label: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  page.drawText(label, { x: 48, y: 780, size: 18 });
  return Buffer.from(await document.save({ useObjectStreams: true }));
}

describe.skipIf(!hasDatabase)('domain signature lifecycle — real PostgreSQL', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let env: Env;
  let storage: FilesystemSignatureObjectStorage;
  let tempRoot: string;
  let userId: string;
  let agreementId: string;
  let versionId: string;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = SHARED_SECRET;

    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    Object.assign(privateJwk, { alg: 'RS256', use: 'sig', kid: 'signature-e2e-key' });
    Object.assign(publicJwk, { alg: 'RS256', use: 'sig', kid: 'signature-e2e-key' });
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'uoa-signature-e2e-'));
    env = parseEnv({
      NODE_ENV: 'test',
      SHARED_SECRET,
      PUBLIC_BASE_URL: 'https://auth.example.com',
      DATABASE_URL: handle.databaseUrl,
      SIGNATURE_STORAGE_PROVIDER: 'filesystem',
      SIGNATURE_FILESYSTEM_ROOT: tempRoot,
      SIGNATURE_EVIDENCE_PRIVATE_JWK: JSON.stringify(privateJwk),
      SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
    });
    storage = new FilesystemSignatureObjectStorage(tempRoot);

    const source = await createPdf('Agreement source version 1');
    const sourceKey = 'sources/signatures.example.com/agreement/version-1/source.pdf';
    await storage.putImmutable(sourceKey, source, 'application/pdf');
    const user = await handle.prisma.user.create({
      data: {
        email: 'signer@example.com',
        name: 'Profile Name',
        userKey: 'signer@example.com',
      },
    });
    userId = user.id;
    await handle.prisma.clientDomain.create({
      data: { domain: DOMAIN, label: 'Signature E2E domain' },
    });
    await handle.prisma.domainSignatureSettings.create({
      data: { domain: DOMAIN, enabled: true, policyRevision: 1, retentionDays: 365 },
    });
    const agreement = await handle.prisma.agreement.create({
      data: {
        domain: DOMAIN,
        title: 'Service terms',
        description: 'Terms required for access.',
        displayOrder: 1,
        requiredForAccess: true,
      },
    });
    agreementId = agreement.id;
    const version = await handle.prisma.agreementVersion.create({
      data: {
        agreementId,
        version: 1,
        title: 'Service terms — July 2026',
        originalFilename: 'service-terms-v1.pdf',
        sourceStorageKey: sourceKey,
        sourcePdfSha256: hashPdf(source),
        signingMethod: 'TYPED_NAME',
        acceptanceStatement: 'I accept Service terms version 1.',
        status: 'PUBLISHED',
        publishedAt: NOW,
        effectiveAt: NOW,
        publishedByEmail: 'admin@example.com',
      },
    });
    versionId = version.id;
  }, 30_000);

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    if (handle) await handle.cleanup();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('signs, verifies, revokes, re-signs, and enforces immutable evidence', async () => {
    const deps = {
      env,
      prisma: handle!.prisma,
      sharedSecret: SHARED_SECRET,
      storage,
      publicBaseUrl: 'https://auth.example.com',
      now: () => NOW,
    };
    const gateInput = {
      userId,
      domain: DOMAIN,
      configUrl: CONFIG_URL,
      redirectUrl: REDIRECT_URL,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256' as const,
      rememberMe: true,
      requestAccess: false,
      authMethod: 'email_password',
      twoFaCompleted: true,
    };

    const gate = await finalizeConfigAuthorizationWithSignatures(gateInput, deps);
    expect(gate.status).toBe('signing_required');
    if (gate.status !== 'signing_required') throw new Error('signature gate did not run');
    expect(await handle!.prisma.authorizationCode.count()).toBe(0);
    const continuation = await handle!.prisma.signingContinuation.findUniqueOrThrow({
      where: { tokenHash: hashSigningContinuationToken(gate.signingToken, SHARED_SECRET) },
    });
    expect(JSON.stringify(continuation)).not.toContain(gate.signingToken);

    const initialSession = await readSigningSession(gate.signingToken, deps);
    expect(initialSession.complete).toBe(false);
    expect(initialSession.agreements.map((item) => item.agreementVersionId)).toEqual([versionId]);

    const signature = await signAgreementVersion(
      {
        signingToken: gate.signingToken,
        agreementVersionId: versionId,
        accepted: true,
        typedName: 'Entered Legal Name',
        ipAddress: '203.0.113.20',
        userAgent: 'Signature E2E browser',
      },
      deps,
    );
    const retry = await signAgreementVersion(
      {
        signingToken: gate.signingToken,
        agreementVersionId: versionId,
        accepted: true,
        typedName: 'Entered Legal Name',
      },
      deps,
    );
    expect(retry.id).toBe(signature.id);
    expect(await handle!.prisma.agreementSignature.count()).toBe(1);
    const claim = await handle!.prisma.signatureClaimIntent.findUniqueOrThrow({
      where: {
        signingContinuationId_agreementVersionId: {
          signingContinuationId: continuation.id,
          agreementVersionId: versionId,
        },
      },
    });
    expect(claim).toMatchObject({ status: 'COMPLETED', id: signature.claimIntentId });
    await expect(
      handle!.prisma.signatureClaimIntent.update({
        where: { id: claim.id },
        data: { signerName: 'Tampered claim' },
      }),
    ).rejects.toThrow();

    const receipt = await readSigningReceipt(
      { signingToken: gate.signingToken, signatureId: signature.id },
      deps,
    );
    expect(hashPdf(receipt.value)).toBe(signature.receiptPdfSha256);
    expect((await readSigningSession(gate.signingToken, deps)).complete).toBe(true);

    const completed = await completeSigningContinuation(gate.signingToken, deps);
    expect(completed.status).toBe('granted');
    if (completed.status !== 'granted') throw new Error('continuation did not complete');
    await expect(completeSigningContinuation(gate.signingToken, deps)).rejects.toThrowError(
      'AUTHENTICATION_FAILED',
    );
    await expect(
      consumeAuthorizationCode({
        code: completed.code,
        configUrl: CONFIG_URL,
        domain: DOMAIN,
        redirectUrl: REDIRECT_URL,
        codeVerifier: CODE_VERIFIER,
        now: new Date(NOW.getTime() + 1_000),
        sharedSecret: SHARED_SECRET,
        prisma: handle!.prisma,
      }),
    ).resolves.toMatchObject({ userId, rememberMe: true });

    await expect(
      verifyPublicSignatureReference(signature.verificationReference, deps),
    ).resolves.toMatchObject({ state: 'valid', integrityVerified: true });
    await expect(
      getCurrentSignatureStatus({ domain: DOMAIN, userId }, deps),
    ).resolves.toMatchObject({
      enabled: true,
      complete: true,
    });

    await revokeAgreementSignature(
      {
        domain: DOMAIN,
        signatureId: signature.id,
        reason: 'Access agreement withdrawn by operator.',
        actorEmail: 'admin@example.com',
      },
      { prisma: handle!.prisma, storage },
    );
    await expect(
      verifyPublicSignatureReference(signature.verificationReference, deps),
    ).resolves.toMatchObject({ state: 'revoked', integrityVerified: true });
    expect((await getCurrentSignatureStatus({ domain: DOMAIN, userId }, deps)).complete).toBe(
      false,
    );

    await expect(
      handle!.prisma.agreementSignature.update({
        where: { id: signature.id },
        data: { signerName: 'Tampered' },
      }),
    ).rejects.toThrow();
    await expect(
      handle!.prisma.agreementSignature.delete({ where: { id: signature.id } }),
    ).rejects.toThrow();
    await expect(
      handle!.prisma.agreementVersion.update({
        where: { id: versionId },
        data: { title: 'Tampered title' },
      }),
    ).rejects.toThrow();
    await expect(handle!.prisma.user.delete({ where: { id: userId } })).rejects.toThrow();

    const resignGate = await finalizeConfigAuthorizationWithSignatures(gateInput, {
      ...deps,
      now: () => new Date(NOW.getTime() + 2_000),
    });
    expect(resignGate.status).toBe('signing_required');
    if (resignGate.status !== 'signing_required') throw new Error('re-sign gate did not run');
    const replacement = await signAgreementVersion(
      {
        signingToken: resignGate.signingToken,
        agreementVersionId: versionId,
        accepted: true,
        typedName: 'Entered Legal Name',
      },
      { ...deps, now: () => new Date(NOW.getTime() + 2_000) },
    );
    expect(replacement.id).not.toBe(signature.id);
    expect((await getCurrentSignatureStatus({ domain: DOMAIN, userId }, deps)).complete).toBe(true);
  }, 30_000);

  it('publishing a replacement version immediately requires a new signature', async () => {
    const source = await createPdf('Agreement source version 2');
    const sourceKey = 'sources/signatures.example.com/agreement/version-2/source.pdf';
    await storage.putImmutable(sourceKey, source, 'application/pdf');
    const draft = await handle!.prisma.agreementVersion.create({
      data: {
        agreementId,
        version: 2,
        title: 'Service terms — replacement',
        originalFilename: 'service-terms-v2.pdf',
        sourceStorageKey: sourceKey,
        sourcePdfSha256: hashPdf(source),
        signingMethod: 'CLICKWRAP',
        acceptanceStatement: 'I accept Service terms version 2.',
        status: 'DRAFT',
      },
    });
    await publishAgreementVersion(
      {
        domain: DOMAIN,
        agreementId,
        versionId: draft.id,
        effectiveAt: new Date(NOW.getTime() + 3_000),
        actorEmail: 'admin@example.com',
      },
      { prisma: handle!.prisma, now: () => new Date(NOW.getTime() + 3_000) },
    );

    const status = await getCurrentSignatureStatus(
      { domain: DOMAIN, userId },
      { env, prisma: handle!.prisma, storage, now: () => new Date(NOW.getTime() + 3_000) },
    );
    expect(status.complete).toBe(false);
    expect(status.requirements).toHaveLength(1);
    expect(status.requirements[0]).toMatchObject({
      agreementVersionId: draft.id,
      version: 2,
      satisfied: false,
    });
    await expect(
      handle!.prisma.agreementVersion.findUniqueOrThrow({ where: { id: versionId } }),
    ).resolves.toMatchObject({ status: 'SUPERSEDED' });
  }, 30_000);
});

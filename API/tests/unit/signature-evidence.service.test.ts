import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import {
  canonicalJson,
  createSignatureEvidence,
  signEvidenceManifest,
  verifyEvidenceManifest,
  type SignatureEvidenceManifest,
} from '../../src/services/signature-evidence.service.js';
import {
  buildSignatureReceiptPdf,
  hashPdf,
  validateSourcePdf,
} from '../../src/services/signature-pdf.service.js';
import { FilesystemSignatureObjectStorage } from '../../src/services/signature-storage.service.js';

const SHARED_SECRET = 'test-shared-secret-that-is-at-least-thirty-two-bytes';
let privateJwkJson: string;
let publicJwksJson: string;
let tempRoot: string;

async function sourcePdf(pageCount = 1): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([595.28, 841.89]);
    page.drawText(`Agreement source page ${index + 1}`, { x: 48, y: 780, size: 18, font });
    page.drawText('These source pages must precede the evidence certificate.', {
      x: 48,
      y: 750,
      size: 10,
      font,
    });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function manifest(sourceSha256: string): SignatureEvidenceManifest {
  return {
    schemaVersion: 1,
    signatureId: 'sig_01JZTESTSIGNATURE',
    verificationReference: 'verify_01JZNONGUESSABLEREFERENCE',
    userId: 'user_01JZTEST',
    userEmail: 'jose@example.com',
    signerName: 'José Example',
    domain: 'example.com',
    agreementId: 'agreement_01JZTEST',
    agreementVersionId: 'version_01JZTEST',
    agreementVersion: 3,
    agreementTitle: 'Universal Service Agreement',
    sourcePdfSha256: sourceSha256,
    acceptanceStatement: 'I have reviewed and agree to this version of the agreement.',
    signingMethod: 'TYPED_NAME',
    typedName: 'José Example',
    signedAt: '2026-07-15T20:30:00.000Z',
    authMethod: 'password',
    twoFaCompleted: true,
    ipAddress: '203.0.113.25',
    userAgent: 'Evidence test browser',
    signingContinuationId: 'continuation_01JZTEST',
  };
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  Object.assign(privateJwk, { alg: 'RS256', use: 'sig', kid: 'evidence-test-2026-07' });
  Object.assign(publicJwk, { alg: 'RS256', use: 'sig', kid: 'evidence-test-2026-07' });
  privateJwkJson = JSON.stringify(privateJwk);
  publicJwksJson = JSON.stringify({ keys: [publicJwk] });
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'uoa-signature-evidence-'));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('signature PDF safety and receipt generation', () => {
  it('validates a real PDF and returns its exact source hash and page count', async () => {
    const source = await sourcePdf(2);
    await expect(validateSourcePdf(source)).resolves.toEqual({
      byteLength: source.byteLength,
      pageCount: 2,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
  });

  it('rejects forged, active-content, escaped-script-name, oversized, and over-page PDFs', async () => {
    const source = await sourcePdf(2);
    await expect(validateSourcePdf(Buffer.from('not a PDF'))).rejects.toThrowError('INVALID_PDF');
    await expect(
      validateSourcePdf(Buffer.concat([source.subarray(0, -5), Buffer.from('/JavaScript\n%%EOF')])),
    ).rejects.toThrowError('PDF_ACTIVE_CONTENT_NOT_ALLOWED');
    await expect(
      validateSourcePdf(Buffer.concat([source.subarray(0, -5), Buffer.from('/Java#53cript\n%%EOF')])),
    ).rejects.toThrowError('PDF_ACTIVE_CONTENT_NOT_ALLOWED');

    const smallEnv = parseEnv({
      NODE_ENV: 'test',
      SHARED_SECRET,
      SIGNATURE_MAX_PDF_BYTES: '1024',
    });
    await expect(validateSourcePdf(Buffer.concat([source, Buffer.alloc(1024)]), smallEnv)).rejects.toThrowError(
      'PDF_TOO_LARGE',
    );

    const onePageEnv = parseEnv({
      NODE_ENV: 'test',
      SHARED_SECRET,
      SIGNATURE_MAX_PDF_PAGES: '1',
    });
    await expect(validateSourcePdf(source, onePageEnv)).rejects.toThrowError('PDF_TOO_MANY_PAGES');
  });

  it('appends exactly one evidence certificate page after every source page', async () => {
    const source = await sourcePdf(2);
    const data = manifest(hashPdf(source));
    const receipt = await buildSignatureReceiptPdf(source, {
      signatureId: data.signatureId,
      verificationReference: data.verificationReference,
      verificationUrl: `https://auth.example/signatures/verify/${data.verificationReference}`,
      domain: data.domain,
      agreementId: data.agreementId,
      agreementVersionId: data.agreementVersionId,
      version: data.agreementVersion,
      agreementTitle: data.agreementTitle,
      signerName: data.signerName,
      signerEmail: data.userEmail,
      signingMethod: data.signingMethod,
      typedName: data.typedName ?? undefined,
      acceptanceStatement: data.acceptanceStatement,
      signedAt: new Date(data.signedAt),
      authMethod: data.authMethod,
      twoFaCompleted: data.twoFaCompleted,
      sourcePdfSha256: data.sourcePdfSha256,
      evidenceManifestSha256: 'a'.repeat(64),
    });
    const loaded = await PDFDocument.load(receipt);
    expect(loaded.getPageCount()).toBe(3);
    expect(receipt.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('signed signature evidence', () => {
  it('canonicalises object keys recursively and deterministically', () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: ['x', null] } })).toBe(
      '{"a":{"b":["x",null],"y":true},"z":1}',
    );
  });

  it('signs with the dedicated kid and verifies against the public historical key set', async () => {
    const source = await sourcePdf();
    const value = manifest(hashPdf(source));
    const signed = await signEvidenceManifest(value, privateJwkJson);

    expect(signed.keyId).toBe('evidence-test-2026-07');
    expect(signed.manifestSha256).toBe(
      createHash('sha256').update(signed.canonicalManifest, 'utf8').digest('hex'),
    );
    await expect(verifyEvidenceManifest(signed.compactJws, publicJwksJson)).resolves.toEqual(value);

    const parts = signed.compactJws.split('.');
    const tamperedPayload = Buffer.from('{"tampered":true}', 'utf8').toString('base64url');
    await expect(
      verifyEvidenceManifest(`${parts[0]}.${tamperedPayload}.${parts[2]}`, publicJwksJson),
    ).rejects.toThrowError('SIGNATURE_EVIDENCE_INVALID');
  });

  it('fails closed for a missing, malformed, reused-type, or unknown evidence key', async () => {
    const source = await sourcePdf();
    const value = manifest(hashPdf(source));
    await expect(signEvidenceManifest(value, '{}')).rejects.toThrowError(
      'SIGNATURE_EVIDENCE_KEY_INVALID',
    );

    const reusedKey = JSON.parse(privateJwkJson) as JWK;
    reusedKey.alg = 'ES256';
    await expect(signEvidenceManifest(value, JSON.stringify(reusedKey))).rejects.toThrowError(
      'SIGNATURE_EVIDENCE_KEY_INVALID',
    );

    const signed = await signEvidenceManifest(value, privateJwkJson);
    await expect(verifyEvidenceManifest(signed.compactJws, '{"keys":[]}')).rejects.toThrowError(
      'SIGNATURE_EVIDENCE_INVALID',
    );
  });

  it('creates, hashes, signs, and immutably stores a complete receipt', async () => {
    const source = await sourcePdf(2);
    const value = manifest(hashPdf(source));
    const storage = new FilesystemSignatureObjectStorage(tempRoot);
    const env = parseEnv({
      NODE_ENV: 'test',
      SHARED_SECRET,
      SIGNATURE_STORAGE_PROVIDER: 'filesystem',
      SIGNATURE_FILESYSTEM_ROOT: tempRoot,
      SIGNATURE_EVIDENCE_PRIVATE_JWK: privateJwkJson,
    });
    const created = await createSignatureEvidence({
      manifest: value,
      sourcePdf: source,
      verificationUrl: `https://auth.example/signatures/verify/${value.verificationReference}`,
      storage,
      env,
    });

    expect(created.receiptStorageKey).toBe(
      `receipts/${value.domain}/${value.signatureId}/receipt.pdf`,
    );
    expect(created.receiptPdfSha256).toBe(hashPdf(created.receiptPdf));
    await expect(storage.read(created.receiptStorageKey)).resolves.toEqual(created.receiptPdf);
    await expect(verifyEvidenceManifest(created.compactJws, publicJwksJson)).resolves.toEqual(value);
    await expect(
      createSignatureEvidence({
        manifest: value,
        sourcePdf: source,
        verificationUrl: `https://auth.example/signatures/verify/${value.verificationReference}`,
        storage,
        env,
      }),
    ).rejects.toThrowError('SIGNATURE_OBJECT_ALREADY_EXISTS');
  });

  it('refuses to create evidence when the immutable source hash does not match', async () => {
    const source = await sourcePdf();
    const storage = new FilesystemSignatureObjectStorage(tempRoot);
    const env = parseEnv({
      NODE_ENV: 'test',
      SHARED_SECRET,
      SIGNATURE_STORAGE_PROVIDER: 'filesystem',
      SIGNATURE_FILESYSTEM_ROOT: tempRoot,
      SIGNATURE_EVIDENCE_PRIVATE_JWK: privateJwkJson,
    });
    await expect(
      createSignatureEvidence({
        manifest: manifest('0'.repeat(64)),
        sourcePdf: source,
        verificationUrl: 'https://auth.example/signatures/verify/test',
        storage,
        env,
      }),
    ).rejects.toThrowError('SIGNATURE_SOURCE_HASH_MISMATCH');
  });
});
